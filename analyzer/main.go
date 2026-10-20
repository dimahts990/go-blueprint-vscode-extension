// gograph loads a Go module with full type information and prints a JSON graph
// of its declarations (types, interfaces, funcs, methods) and the relations
// between them (calls, references, implements, embeds, field-type uses).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

type Pos struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

type Field struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Embedded bool   `json:"embedded,omitempty"`
	Exported bool   `json:"exported"`
	Line     int    `json:"line"`
	Proto    string `json:"proto,omitempty"` // protobuf field name
	Num      int    `json:"num,omitempty"`   // protobuf field number
	Label    string `json:"label,omitempty"` // repeated | optional | map | oneof x
	Doc      string `json:"doc,omitempty"`
}

type Node struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"` // struct | interface | type | func | method | imethod | service | rpc | message
	Name       string  `json:"name"`
	Pkg        string  `json:"pkg"`
	Parent     string  `json:"parent,omitempty"`
	Sig        string  `json:"sig,omitempty"`
	Underlying string  `json:"underlying,omitempty"`
	File       string  `json:"file"`
	Line       int     `json:"line"`
	EndLine    int     `json:"endLine"`
	Exported   bool    `json:"exported"`
	PtrRecv    bool    `json:"ptrRecv,omitempty"`
	Doc        string  `json:"doc,omitempty"`
	Fields     []Field `json:"fields,omitempty"`
	Stream     string  `json:"stream,omitempty"` // rpc: unary | server | client | bidi
}

type Edge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Kind  string `json:"kind"` // calls | ref | implements | embeds | uses | dispatch | grpc
	Label string `json:"label,omitempty"`
	Count int    `json:"count"`
	Sites []Pos  `json:"sites,omitempty"`
}

type Package struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Dir   string `json:"dir"`
	Files int    `json:"files"`
}

type Graph struct {
	Module   string    `json:"module"`
	Root     string    `json:"root"`
	Packages []Package `json:"packages"`
	Nodes    []*Node   `json:"nodes"`
	Edges    []*Edge   `json:"edges"`
	Errors   []string  `json:"errors,omitempty"`
	Proto    ProtoInfo `json:"proto"`
}

// ProtoInfo tells the UI where the gRPC layer was looked for.
type ProtoInfo struct {
	Roots     []string `json:"roots"`     // directories searched for .proto files
	Files     int      `json:"files"`     // .proto files found
	Extra     []string `json:"extra"`     // extra package patterns loaded
	Services  int      `json:"services"`  // gRPC services found
	Messages  int      `json:"messages"`  // protobuf messages shown
	FromProto int      `json:"fromProto"` // .proto files parsed directly (no generated code)
	Warnings  []string `json:"warnings,omitempty"`
}

// extraSpec is one -pkgs value: the pattern for go list, and for a directory
// the module it lives in, so it can be loaded on its own if needed.
type extraSpec struct {
	orig, pattern string
	modDir, rel   string
}

// stringList is a repeatable flag.
type stringList []string

func (l *stringList) String() string     { return strings.Join(*l, ",") }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }

const maxSites = 20

type builder struct {
	fset      *token.FileSet
	root      string
	pkgs      map[string]bool // module package paths that were loaded
	extraPkgs map[string]bool // generated-code packages loaded from other modules
	g         *Graph
	nodes     map[string]*Node
	funcIDs   map[*types.Func]string
	typeIDs   map[*types.TypeName]string
	edges     map[string]*Edge
	generated bool

	// gRPC / protobuf layer
	protos       *protoIndex
	pbSource     map[string]string // generated .go file -> its .proto source
	genDocs      map[*types.TypeName]string
	genFieldDocs map[*types.TypeName]map[string]string
	msgIDs       map[*types.TypeName]string
	clientRPC    map[*types.Func]string // generated client method -> rpc node
}

func main() {
	dir := flag.String("dir", ".", "module directory")
	tests := flag.Bool("tests", false, "include _test.go files")
	generated := flag.Bool("generated", false, "include generated files (e.g. *.pb.go)")
	var protoDirs, extraPkgs stringList
	flag.Var(&protoDirs, "proto", "extra directory to search for .proto files (repeatable)")
	flag.Var(&extraPkgs, "pkgs", "extra package pattern or directory with generated gRPC code (repeatable)")
	flag.Parse()

	root, err := filepath.Abs(*dir)
	if err != nil {
		fatal(err)
	}
	patterns := flag.Args()
	if len(patterns) == 0 {
		patterns = []string{"./..."}
	}
	var extraPatterns []string
	var extras []extraSpec
	for _, e := range extraPkgs {
		spec := packagePattern(root, e)
		extras = append(extras, spec)
		extraPatterns = append(extraPatterns, spec.pattern)
	}
	patterns = append(patterns, extraPatterns...)

	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
			packages.NeedTypes | packages.NeedTypesInfo | packages.NeedModule,
		Dir:   root,
		Tests: *tests,
		Fset:  token.NewFileSet(),
	}
	pkgs, err := packages.Load(cfg, patterns...)
	if err != nil {
		fatal(err)
	}

	b := &builder{
		fset:      cfg.Fset,
		root:      root,
		pkgs:      map[string]bool{},
		extraPkgs: map[string]bool{},
		g:         &Graph{Root: root, Nodes: []*Node{}, Edges: []*Edge{}},
		nodes:     map[string]*Node{},
		funcIDs:   map[*types.Func]string{},
		typeIDs:   map[*types.TypeName]string{},
		edges:     map[string]*Edge{},
		generated: *generated,

		pbSource:     map[string]string{},
		genDocs:      map[*types.TypeName]string{},
		genFieldDocs: map[*types.TypeName]map[string]string{},
		msgIDs:       map[*types.TypeName]string{},
		clientRPC:    map[*types.Func]string{},
	}

	// With Tests=true the same package appears several times (p, p [p.test],
	// p_test, p.test). Keep the variant with the most files per path.
	byPath := map[string]*packages.Package{}
	var extraList []*packages.Package
	for _, p := range pkgs {
		for _, e := range p.Errors {
			b.g.Errors = append(b.g.Errors, e.Error())
		}
		if p.Types == nil || p.TypesInfo == nil || strings.HasSuffix(p.PkgPath, ".test") {
			continue
		}
		if p.Module != nil && !p.Module.Main {
			// another module: only its gRPC layer is used
			if !b.extraPkgs[p.PkgPath] {
				b.extraPkgs[p.PkgPath] = true
				extraList = append(extraList, p)
			}
			continue
		}
		if p.Module != nil && b.g.Module == "" {
			b.g.Module = p.Module.Path
		}
		path := strings.TrimSuffix(p.PkgPath, "_test")
		if prev, ok := byPath[p.PkgPath]; !ok || len(p.Syntax) > len(prev.Syntax) {
			byPath[p.PkgPath] = p
		}
		b.pkgs[path] = true
	}
	var list []*packages.Package
	for _, p := range byPath {
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].PkgPath < list[j].PkgPath })

	for _, p := range list {
		dir := ""
		if len(p.GoFiles) > 0 {
			dir = b.rel(filepath.Dir(p.GoFiles[0]))
		}
		b.g.Packages = append(b.g.Packages, Package{Path: p.PkgPath, Name: p.Name, Dir: dir, Files: len(p.Syntax)})
	}

	// Pass 1: declarations, so every callee/type has an ID before edges are built.
	for _, p := range list {
		b.declare(p)
	}
	// gRPC services, RPCs, handlers and protobuf messages.
	extraList = append(extraList, b.loadDetached(cfg, extras, pkgs)...)
	b.grpcLayer(append(append([]*packages.Package{}, list...), extraList...), protoDirs)
	b.protoOnlyLayer()
	if b.g.Module == "" {
		if data, err := os.ReadFile(filepath.Join(root, "go.mod")); err == nil {
			b.g.Module = modulePath(data)
		}
	}
	b.g.Proto.Extra = extraPatterns
	// Pass 2: struct fields and type relations.
	for _, p := range list {
		b.typeRelations(p)
	}
	b.implements()
	// Pass 3: calls and function references.
	for _, p := range list {
		b.calls(p)
	}

	for _, e := range b.edges {
		b.g.Edges = append(b.g.Edges, e)
	}
	for _, n := range b.g.Nodes {
		switch n.Kind {
		case "service":
			b.g.Proto.Services++
		case "message":
			b.g.Proto.Messages++
		}
	}
	sort.Slice(b.g.Nodes, func(i, j int) bool { return b.g.Nodes[i].ID < b.g.Nodes[j].ID })
	sort.Slice(b.g.Edges, func(i, j int) bool {
		a, c := b.g.Edges[i], b.g.Edges[j]
		if a.From != c.From {
			return a.From < c.From
		}
		if a.To != c.To {
			return a.To < c.To
		}
		return a.Kind < c.Kind
	})

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(b.g); err != nil {
		fatal(err)
	}
}

// packagePattern turns a directory into an import-path pattern (dir/... of
// its module); anything else is passed to go list unchanged.
func packagePattern(root, p string) extraSpec {
	spec := extraSpec{orig: p, pattern: p}
	dir := p
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return spec
	}
	for m := dir; ; m = filepath.Dir(m) {
		if data, err := os.ReadFile(filepath.Join(m, "go.mod")); err == nil {
			mod := modulePath(data)
			if mod == "" {
				return spec
			}
			rel, _ := filepath.Rel(m, dir)
			spec.modDir = m
			spec.rel = "./" + filepath.ToSlash(rel) + "/..."
			if rel == "." {
				spec.pattern, spec.rel = mod+"/...", "./..."
			} else {
				spec.pattern = mod + "/" + filepath.ToSlash(rel) + "/..."
			}
			return spec
		}
		if filepath.Dir(m) == m {
			return spec
		}
	}
}

// loadDetached loads extra packages the module does not depend on, from
// inside their own module. They only feed the gRPC layer (no handler links).
func (b *builder) loadDetached(cfg *packages.Config, extras []extraSpec, loaded []*packages.Package) []*packages.Package {
	var out []*packages.Package
	for _, e := range extras {
		prefix := strings.TrimSuffix(e.pattern, "/...")
		matched := false
		for _, p := range loaded {
			if p.PkgPath == prefix || strings.HasPrefix(p.PkgPath, prefix+"/") {
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		if e.modDir == "" {
			b.g.Proto.Warnings = append(b.g.Proto.Warnings,
				"«"+e.orig+"» не загрузился: модуль не зависит от этого пакета (нужен require/replace в go.mod или go.work) — или укажите папку")
			continue
		}
		c2 := *cfg
		c2.Dir = e.modDir
		pkgs, err := packages.Load(&c2, e.rel)
		n := 0
		for _, p := range pkgs {
			if p.Types == nil || p.TypesInfo == nil || b.extraPkgs[p.PkgPath] || b.pkgs[p.PkgPath] {
				continue
			}
			b.extraPkgs[p.PkgPath] = true
			out = append(out, p)
			n++
		}
		if err != nil || n == 0 {
			msg := "«" + e.orig + "»: в папке нет Go-пакетов"
			if err != nil {
				msg = "«" + e.orig + "»: " + err.Error()
			}
			b.g.Proto.Warnings = append(b.g.Proto.Warnings, msg)
		}
	}
	return out
}

func modulePath(gomod []byte) string {
	for _, l := range strings.Split(string(gomod), "\n") {
		l = strings.TrimSpace(l)
		if v, ok := strings.CutPrefix(l, "module "); ok {
			return strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return ""
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "gograph:", err)
	os.Exit(1)
}

func (b *builder) rel(path string) string {
	if r, err := filepath.Rel(b.root, path); err == nil {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(path)
}

func (b *builder) pos(p token.Pos) Pos {
	ps := b.fset.Position(p)
	return Pos{File: b.rel(ps.Filename), Line: ps.Line}
}

func (b *builder) files(p *packages.Package) []*ast.File {
	var out []*ast.File
	for _, f := range p.Syntax {
		if !b.generated && ast.IsGenerated(f) {
			continue
		}
		out = append(out, f)
	}
	return out
}

func (b *builder) add(n *Node) {
	if _, dup := b.nodes[n.ID]; dup {
		return
	}
	b.nodes[n.ID] = n
	b.g.Nodes = append(b.g.Nodes, n)
}

func (b *builder) addEdge(from, to, kind, label string, site *Pos) {
	if from == "" || to == "" {
		return
	}
	key := from + "\x00" + to + "\x00" + kind + "\x00" + label
	e := b.edges[key]
	if e == nil {
		e = &Edge{From: from, To: to, Kind: kind, Label: label}
		b.edges[key] = e
	}
	e.Count++
	if site != nil && len(e.Sites) < maxSites {
		e.Sites = append(e.Sites, *site)
	}
}

func docLine(groups ...*ast.CommentGroup) string {
	for _, g := range groups {
		if g == nil {
			continue
		}
		t := strings.TrimSpace(g.Text())
		if len(t) > 400 {
			t = t[:400] + "…"
		}
		return t
	}
	return ""
}

func qualifier(self *types.Package) types.Qualifier {
	return func(p *types.Package) string {
		if p == self {
			return ""
		}
		return p.Name()
	}
}

func typeParamsString(tps *types.TypeParamList, q types.Qualifier) string {
	if tps == nil || tps.Len() == 0 {
		return ""
	}
	parts := make([]string, tps.Len())
	for i := 0; i < tps.Len(); i++ {
		tp := tps.At(i)
		parts[i] = tp.Obj().Name() + " " + types.TypeString(tp.Constraint(), q)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// sigString renders "(a int, b string) error" without the func keyword.
func sigString(sig *types.Signature, q types.Qualifier) string {
	s := types.TypeString(sig, q)
	return strings.TrimPrefix(s, "func")
}

func (b *builder) declare(p *packages.Package) {
	q := qualifier(p.Types)
	for _, f := range b.files(p) {
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.GenDecl:
				if d.Tok != token.TYPE {
					continue
				}
				for _, spec := range d.Specs {
					ts := spec.(*ast.TypeSpec)
					obj, ok := p.TypesInfo.Defs[ts.Name].(*types.TypeName)
					if !ok || obj == nil {
						continue
					}
					id := p.PkgPath + "." + ts.Name.Name
					b.typeIDs[obj] = id
					start, end := b.pos(ts.Pos()), b.pos(ts.End())
					if !d.Lparen.IsValid() { // single "type X ..." — start at the keyword
						start = b.pos(d.Pos())
					}
					n := &Node{
						ID: id, Name: ts.Name.Name, Pkg: p.PkgPath,
						File: start.File, Line: start.Line, EndLine: end.Line,
						Exported: ts.Name.IsExported(),
						Doc:      docLine(ts.Doc, d.Doc),
					}
					if named, ok := obj.Type().(*types.Named); ok {
						n.Name += typeParamsString(named.TypeParams(), q)
					}
					switch u := obj.Type().Underlying().(type) {
					case *types.Struct:
						n.Kind = "struct"
					case *types.Interface:
						n.Kind = "interface"
						b.declareInterface(p, n, ts, u)
					default:
						n.Kind = "type"
						n.Underlying = types.TypeString(u, q)
						if ts.Assign.IsValid() {
							n.Underlying = "= " + types.TypeString(obj.Type(), q)
						}
					}
					b.add(n)
				}
			case *ast.FuncDecl:
				fn, ok := p.TypesInfo.Defs[d.Name].(*types.Func)
				if !ok || fn == nil {
					continue
				}
				sig := fn.Type().(*types.Signature)
				start, end := b.pos(d.Pos()), b.pos(d.End())
				n := &Node{
					Name: d.Name.Name, Pkg: p.PkgPath,
					Sig:  typeParamsString(sig.TypeParams(), q) + sigString(sig, q),
					File: start.File, Line: start.Line, EndLine: end.Line,
					Exported: d.Name.IsExported(),
					Doc:      docLine(d.Doc),
				}
				if recv := sig.Recv(); recv != nil {
					t := recv.Type()
					if ptr, ok := t.(*types.Pointer); ok {
						t = ptr.Elem()
						n.PtrRecv = true
					}
					named, ok := t.(*types.Named)
					if !ok {
						continue
					}
					tn := named.Origin().Obj()
					n.Kind = "method"
					n.Parent = p.PkgPath + "." + tn.Name()
					n.ID = n.Parent + "." + d.Name.Name
					n.Sig = sigString(sig, q)
				} else {
					n.Kind = "func"
					n.ID = p.PkgPath + "." + d.Name.Name
					if d.Name.Name == "init" || d.Name.Name == "_" {
						n.ID += "#" + start.File + ":" + fmt.Sprint(start.Line)
					}
				}
				b.funcIDs[fn] = n.ID
				b.add(n)
			}
		}
	}
}

func (b *builder) declareInterface(p *packages.Package, owner *Node, ts *ast.TypeSpec, iface *types.Interface) {
	q := qualifier(p.Types)
	// Map AST method names to their positions for source navigation.
	astPos := map[string]ast.Node{}
	if it, ok := ts.Type.(*ast.InterfaceType); ok && it.Methods != nil {
		for _, m := range it.Methods.List {
			for _, name := range m.Names {
				astPos[name.Name] = m
			}
		}
	}
	for i := 0; i < iface.NumExplicitMethods(); i++ {
		m := iface.ExplicitMethod(i)
		id := owner.ID + "." + m.Name()
		n := &Node{
			ID: id, Kind: "imethod", Name: m.Name(), Pkg: p.PkgPath, Parent: owner.ID,
			Sig:      sigString(m.Type().(*types.Signature), q),
			Exported: m.Exported(),
			File:     owner.File, Line: owner.Line, EndLine: owner.Line,
		}
		if an, ok := astPos[m.Name()]; ok {
			s, e := b.pos(an.Pos()), b.pos(an.End())
			n.File, n.Line, n.EndLine = s.File, s.Line, e.Line
			if f, ok := an.(*ast.Field); ok {
				n.Doc = docLine(f.Doc, f.Comment)
			}
		}
		b.funcIDs[m] = id
		b.add(n)
	}
}

// namedIn calls fn for every named type mentioned in t (through pointers,
// slices, maps, chans, funcs and generic arguments).
func namedIn(t types.Type, fn func(*types.TypeName), seen map[types.Type]bool) {
	if t == nil || seen[t] {
		return
	}
	seen[t] = true
	switch t := t.(type) {
	case *types.Named:
		fn(t.Origin().Obj())
		if args := t.TypeArgs(); args != nil {
			for i := 0; i < args.Len(); i++ {
				namedIn(args.At(i), fn, seen)
			}
		}
	case *types.Alias:
		namedIn(types.Unalias(t), fn, seen)
	case *types.Pointer:
		namedIn(t.Elem(), fn, seen)
	case *types.Slice:
		namedIn(t.Elem(), fn, seen)
	case *types.Array:
		namedIn(t.Elem(), fn, seen)
	case *types.Map:
		namedIn(t.Key(), fn, seen)
		namedIn(t.Elem(), fn, seen)
	case *types.Chan:
		namedIn(t.Elem(), fn, seen)
	case *types.Signature:
		for i := 0; i < t.Params().Len(); i++ {
			namedIn(t.Params().At(i).Type(), fn, seen)
		}
		for i := 0; i < t.Results().Len(); i++ {
			namedIn(t.Results().At(i).Type(), fn, seen)
		}
	}
}

func (b *builder) typeRelations(p *packages.Package) {
	q := qualifier(p.Types)
	for _, f := range b.files(p) {
		for _, decl := range f.Decls {
			d, ok := decl.(*ast.GenDecl)
			if !ok || d.Tok != token.TYPE {
				continue
			}
			for _, spec := range d.Specs {
				ts := spec.(*ast.TypeSpec)
				obj, ok := p.TypesInfo.Defs[ts.Name].(*types.TypeName)
				if !ok || obj == nil {
					continue
				}
				id := b.typeIDs[obj]
				n := b.nodes[id]
				if n == nil {
					continue
				}
				switch u := obj.Type().Underlying().(type) {
				case *types.Struct:
					for i := 0; i < u.NumFields(); i++ {
						fv := u.Field(i)
						fld := Field{
							Name: fv.Name(), Type: types.TypeString(fv.Type(), q),
							Embedded: fv.Embedded(), Exported: fv.Exported(),
							Line: b.pos(fv.Pos()).Line,
						}
						n.Fields = append(n.Fields, fld)
						kind := "uses"
						if fv.Embedded() {
							kind = "embeds"
						}
						namedIn(fv.Type(), func(tn *types.TypeName) {
							if to := b.typeIDs[tn]; to != "" && to != id {
								b.addEdge(id, to, kind, fv.Name(), nil)
							}
						}, map[types.Type]bool{})
					}
				case *types.Interface:
					for i := 0; i < u.NumEmbeddeds(); i++ {
						namedIn(u.EmbeddedType(i), func(tn *types.TypeName) {
							if to := b.typeIDs[tn]; to != "" && to != id {
								b.addEdge(id, to, "embeds", "", nil)
							}
						}, map[types.Type]bool{})
					}
				default:
					namedIn(u, func(tn *types.TypeName) {
						if to := b.typeIDs[tn]; to != "" && to != id {
							b.addEdge(id, to, "uses", "", nil)
						}
					}, map[types.Type]bool{})
				}
			}
		}
	}
}

// implements links every concrete module type to every non-empty module
// interface it satisfies, and each interface method to the implementing method.
func (b *builder) implements() {
	type tn struct {
		obj *types.TypeName
		id  string
	}
	var concrete, ifaces []tn
	for obj, id := range b.typeIDs {
		if obj.IsAlias() || b.msgIDs[obj] != "" {
			continue
		}
		named, ok := obj.Type().(*types.Named)
		if !ok || (named.TypeParams() != nil && named.TypeParams().Len() > 0) {
			continue
		}
		if it, ok := named.Underlying().(*types.Interface); ok {
			if it.NumMethods() > 0 {
				ifaces = append(ifaces, tn{obj, id})
			}
		} else {
			concrete = append(concrete, tn{obj, id})
		}
	}
	for _, c := range concrete {
		T := c.obj.Type()
		PT := types.NewPointer(T)
		for _, i := range ifaces {
			I := i.obj.Type().Underlying().(*types.Interface)
			if !types.Implements(T, I) && !types.Implements(PT, I) {
				continue
			}
			b.addEdge(c.id, i.id, "implements", "", nil)
			for k := 0; k < I.NumMethods(); k++ {
				im := I.Method(k)
				imID := b.funcIDs[im]
				obj, _, _ := types.LookupFieldOrMethod(PT, true, im.Pkg(), im.Name())
				if fn, ok := obj.(*types.Func); ok {
					if cid := b.funcIDs[fn.Origin()]; cid != "" && imID != "" {
						b.addEdge(imID, cid, "dispatch", "", nil)
					}
				}
			}
		}
	}
}

func unparen(e ast.Expr) ast.Expr {
	for {
		switch x := e.(type) {
		case *ast.ParenExpr:
			e = x.X
		case *ast.IndexExpr: // generic instantiation f[T](...)
			e = x.X
		case *ast.IndexListExpr:
			e = x.X
		default:
			return e
		}
	}
}

func (b *builder) funcID(obj types.Object) string {
	fn, ok := obj.(*types.Func)
	if !ok {
		return ""
	}
	return b.funcIDs[fn.Origin()]
}

func (b *builder) calls(p *packages.Package) {
	info := p.TypesInfo
	for _, f := range b.files(p) {
		for _, decl := range f.Decls {
			d, ok := decl.(*ast.FuncDecl)
			if !ok || d.Body == nil {
				continue
			}
			fn, _ := info.Defs[d.Name].(*types.Func)
			caller := b.funcIDs[fn]
			if caller == "" {
				continue
			}
			handled := map[*ast.Ident]bool{}
			ast.Inspect(d.Body, func(n ast.Node) bool {
				switch x := n.(type) {
				case *ast.CallExpr:
					var id *ast.Ident
					switch fun := unparen(x.Fun).(type) {
					case *ast.Ident:
						id = fun
					case *ast.SelectorExpr:
						id = fun.Sel
					}
					if id == nil {
						return true
					}
					handled[id] = true
					if callee := b.funcID(info.Uses[id]); callee != "" {
						site := b.pos(x.Lparen)
						b.addEdge(caller, callee, "calls", "", &site)
					} else if fn, ok := info.Uses[id].(*types.Func); ok && b.clientRPC[fn] != "" {
						site := b.pos(x.Lparen)
						b.addEdge(caller, b.clientRPC[fn], "grpc", "client", &site)
					}
				case *ast.CompositeLit:
					// building a protobuf message: what this code puts on the wire
					if t := info.TypeOf(x); t != nil {
						if mid := b.ensureMessage(t, false); mid != "" {
							site := b.pos(x.Lbrace)
							b.addEdge(caller, mid, "grpc", "builds", &site)
						}
					}
				case *ast.Ident:
					if handled[x] {
						return true
					}
					if callee := b.funcID(info.Uses[x]); callee != "" && callee != caller {
						site := b.pos(x.Pos())
						b.addEdge(caller, callee, "ref", "", &site)
					}
				}
				return true
			})
		}
	}
}
