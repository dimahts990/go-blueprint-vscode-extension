package main

// gRPC / protobuf layer: services and RPCs from the generated *_ServiceDesc,
// handlers from module types implementing the generated server interface,
// messages from types with a ProtoReflect method, positions from .proto files.

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/tools/go/packages"
)

type rpcDesc struct {
	name           string
	client, server bool // streaming directions
}

type svcDesc struct {
	name     string // full proto name, e.g. winch.v1.WinchConfigService
	handler  string // generated server interface name
	metadata string // proto file, e.g. object/winch_config/v1/winch_config.proto
	methods  []rpcDesc
}

type protoIndex struct {
	files []string            // absolute .proto paths
	lines map[string][]string // cache
}

func strVal(info *types.Info, e ast.Expr) string {
	if tv, ok := info.Types[e]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		return constant.StringVal(tv.Value)
	}
	if bl, ok := e.(*ast.BasicLit); ok && bl.Kind == token.STRING {
		s, _ := strconv.Unquote(bl.Value)
		return s
	}
	return ""
}

func keyName(e ast.Expr) string {
	if id, ok := e.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

func isTrue(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == "true"
}

// parseServiceDescs reads `var X_ServiceDesc = grpc.ServiceDesc{...}` literals.
func parseServiceDescs(info *types.Info, f *ast.File) []svcDesc {
	var out []svcDesc
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.VAR {
			continue
		}
		for _, spec := range gd.Specs {
			vs := spec.(*ast.ValueSpec)
			for i, name := range vs.Names {
				if !strings.HasSuffix(name.Name, "_ServiceDesc") || i >= len(vs.Values) {
					continue
				}
				lit, ok := vs.Values[i].(*ast.CompositeLit)
				if !ok {
					continue
				}
				var d svcDesc
				for _, el := range lit.Elts {
					kv, ok := el.(*ast.KeyValueExpr)
					if !ok {
						continue
					}
					switch keyName(kv.Key) {
					case "ServiceName":
						d.name = strVal(info, kv.Value)
					case "Metadata":
						d.metadata = strVal(info, kv.Value)
					case "HandlerType": // (*XServer)(nil)
						ast.Inspect(kv.Value, func(n ast.Node) bool {
							if st, ok := n.(*ast.StarExpr); ok {
								if id, ok := st.X.(*ast.Ident); ok {
									d.handler = id.Name
								}
								return false
							}
							return true
						})
					case "Methods", "Streams":
						list, ok := kv.Value.(*ast.CompositeLit)
						if !ok {
							continue
						}
						for _, m := range list.Elts {
							ml, ok := m.(*ast.CompositeLit)
							if !ok {
								continue
							}
							var r rpcDesc
							for _, f := range ml.Elts {
								fkv, ok := f.(*ast.KeyValueExpr)
								if !ok {
									continue
								}
								switch keyName(fkv.Key) {
								case "MethodName", "StreamName":
									r.name = strVal(info, fkv.Value)
								case "ServerStreams":
									r.server = isTrue(fkv.Value)
								case "ClientStreams":
									r.client = isTrue(fkv.Value)
								}
							}
							if r.name != "" {
								d.methods = append(d.methods, r)
							}
						}
					}
				}
				if d.name != "" && d.handler != "" {
					out = append(out, d)
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- .proto files

// findProtoFiles walks the module root, or the enclosing repository when the
// module sits inside one (protos usually live next to the Go code).
// Extra directories given by the user are searched as well.
func findProtoFiles(root string, extra []string) (*protoIndex, []string) {
	idx := &protoIndex{lines: map[string][]string{}}
	walkRoot := root
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		if _, err := os.Stat(filepath.Join(filepath.Dir(root), ".git")); err == nil {
			walkRoot = filepath.Dir(root)
		}
	}
	roots := []string{walkRoot}
	for _, e := range extra {
		if !filepath.IsAbs(e) {
			e = filepath.Join(root, e)
		}
		roots = append(roots, filepath.Clean(e))
	}
	seen := map[string]bool{}
	for _, r := range roots {
		walkProtos(idx, r, seen)
	}
	return idx, roots
}

func walkProtos(idx *protoIndex, walkRoot string, seen map[string]bool) {
	skip := map[string]bool{"node_modules": true, "vendor": true, ".git": true, "dist": true, "build": true, ".idea": true, ".vscode": true}
	_ = filepath.WalkDir(walkRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != walkRoot && (skip[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".proto") && len(idx.files) < 5000 && !seen[path] {
			seen[path] = true
			idx.files = append(idx.files, path)
		}
		return nil
	})
}

func (idx *protoIndex) find(source string) string {
	if source == "" {
		return ""
	}
	source = filepath.ToSlash(source)
	best := ""
	for _, f := range idx.files {
		s := filepath.ToSlash(f)
		if s == source || strings.HasSuffix(s, "/"+source) {
			if best == "" || len(s) < len(best) {
				best = f
			}
		}
	}
	if best == "" { // fall back to the bare file name
		base := "/" + filepath.Base(source)
		for _, f := range idx.files {
			if strings.HasSuffix(filepath.ToSlash(f), base) {
				return f
			}
		}
	}
	return best
}

func (idx *protoIndex) fileLines(path string) []string {
	if l, ok := idx.lines[path]; ok {
		return l
	}
	data, err := os.ReadFile(path)
	if err != nil {
		idx.lines[path] = nil
		return nil
	}
	l := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	idx.lines[path] = l
	return l
}

// locate finds `<kind> <name>` in a .proto file and returns 1-based lines.
func (idx *protoIndex) locate(path, kind, name string) (int, int, bool) {
	lines := idx.fileLines(path)
	if lines == nil {
		return 0, 0, false
	}
	pat := `^\s*` + kind + `\s+` + regexp.QuoteMeta(name) + `\b`
	if kind == "rpc" {
		pat = `^\s*rpc\s+` + regexp.QuoteMeta(name) + `\s*\(`
	}
	re := regexp.MustCompile(pat)
	for i, l := range lines {
		if !re.MatchString(l) {
			continue
		}
		start := i
		// include leading comment lines
		for start > 0 && strings.HasPrefix(strings.TrimSpace(lines[start-1]), "//") {
			start--
		}
		end := i
		depth, opened := 0, false
		for j := i; j < len(lines); j++ {
			code := lines[j]
			if k := strings.Index(code, "//"); k >= 0 {
				code = code[:k]
			}
			for _, c := range code {
				switch c {
				case '{':
					depth++
					opened = true
				case '}':
					depth--
				}
			}
			end = j
			if opened && depth <= 0 {
				break
			}
			if !opened && strings.Contains(code, ";") {
				break
			}
		}
		return start + 1, end + 1, true
	}
	return 0, 0, false
}

// ---------------------------------------------------------------- builder parts

// collectGenerated indexes doc comments and proto sources of generated files.
func (b *builder) collectGenerated(p *packages.Package) {
	for _, f := range p.Syntax {
		if !ast.IsGenerated(f) {
			continue
		}
		fname := b.fset.Position(f.Pos()).Filename
		for _, cg := range f.Comments {
			for _, c := range cg.List {
				if s, ok := strings.CutPrefix(c.Text, "// source: "); ok {
					b.pbSource[fname] = strings.TrimSpace(s)
				}
			}
			if cg.Pos() > f.Package {
				break
			}
		}
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.TYPE {
				continue
			}
			for _, spec := range gd.Specs {
				ts := spec.(*ast.TypeSpec)
				obj, ok := p.TypesInfo.Defs[ts.Name].(*types.TypeName)
				if !ok {
					continue
				}
				b.genDocs[obj] = docLine(ts.Doc, gd.Doc)
				if st, ok := ts.Type.(*ast.StructType); ok {
					m := map[string]string{}
					for _, fl := range st.Fields.List {
						for _, n := range fl.Names {
							if d := docLine(fl.Doc, fl.Comment); d != "" {
								m[n.Name] = d
							}
						}
					}
					b.genFieldDocs[obj] = m
				}
			}
		}
	}
}

func (b *builder) grpcLayer(list []*packages.Package, protoDirs []string) {
	var roots []string
	b.protos, roots = findProtoFiles(b.root, protoDirs)
	for _, r := range roots {
		b.g.Proto.Roots = append(b.g.Proto.Roots, b.rel(r))
	}
	b.g.Proto.Files = len(b.protos.files)
	for _, p := range list {
		b.collectGenerated(p)
	}
	for _, p := range list {
		for _, f := range p.Syntax {
			if !strings.HasSuffix(b.fset.Position(f.Pos()).Filename, "_grpc.pb.go") {
				continue
			}
			for _, d := range parseServiceDescs(p.TypesInfo, f) {
				b.addService(p, d)
			}
		}
	}
}

// setProtoLoc points a node at its .proto declaration when one is found.
func (b *builder) setProtoLoc(n *Node, source, kind, name string) bool {
	path := b.protos.find(source)
	if path == "" {
		return false
	}
	names := []string{name}
	if i := strings.LastIndex(name, "_"); i >= 0 && kind == "message" { // nested: Outer_Inner
		names = append(names, name[i+1:])
	}
	for _, nm := range names {
		if s, e, ok := b.protos.locate(path, kind, nm); ok {
			n.File, n.Line, n.EndLine = b.rel(path), s, e
			return true
		}
	}
	return false
}

func shortType(t types.Type) string {
	t = types.Unalias(t)
	if p, ok := t.(*types.Pointer); ok {
		t = p.Elem()
	}
	if n, ok := t.(*types.Named); ok {
		return n.Obj().Name()
	}
	return types.TypeString(t, func(*types.Package) string { return "" })
}

// rpcTypes extracts request and response message types from a server method.
func rpcTypes(sig *types.Signature, r rpcDesc) (req, resp types.Type) {
	params := sig.Params()
	if !r.client && !r.server { // (ctx, *Req) (*Resp, error)
		if params.Len() >= 2 {
			req = params.At(1).Type()
		}
		if sig.Results().Len() >= 1 {
			resp = sig.Results().At(0).Type()
		}
		return
	}
	if params.Len() == 0 {
		return
	}
	if !r.client && params.Len() >= 2 {
		req = params.At(0).Type()
	}
	stream := types.Unalias(params.At(params.Len() - 1).Type())
	if named, ok := stream.(*types.Named); ok && named.TypeArgs().Len() > 0 {
		args := named.TypeArgs()
		if args.Len() == 1 { // ServerStreamingServer[Res]
			resp = args.At(0)
		} else { // ClientStreamingServer[Req, Res], BidiStreamingServer[Req, Res]
			req, resp = args.At(0), args.At(1)
		}
		return
	}
	// pre-generics style: Xxx_YyyServer interface with Send / Recv
	if obj, _, _ := types.LookupFieldOrMethod(stream, true, nil, "Send"); obj != nil {
		if s, ok := obj.Type().(*types.Signature); ok && s.Params().Len() == 1 {
			resp = s.Params().At(0).Type()
		}
	}
	if obj, _, _ := types.LookupFieldOrMethod(stream, true, nil, "Recv"); obj != nil && r.client {
		if s, ok := obj.Type().(*types.Signature); ok && s.Results().Len() >= 1 {
			req = s.Results().At(0).Type()
		}
	}
	return
}

func (b *builder) addService(p *packages.Package, d svcDesc) {
	obj, ok := p.Types.Scope().Lookup(d.handler).(*types.TypeName)
	if !ok {
		return
	}
	iface, ok := obj.Type().Underlying().(*types.Interface)
	if !ok {
		return
	}
	short := d.name[strings.LastIndex(d.name, ".")+1:]
	id := "grpc:" + d.name
	start := b.pos(obj.Pos())
	svc := &Node{
		ID: id, Kind: "service", Name: short, Pkg: p.PkgPath, Exported: true,
		File: start.File, Line: start.Line, EndLine: start.Line,
		Doc: "gRPC service " + d.name + "\nproto: " + d.metadata,
	}
	b.setProtoLoc(svc, d.metadata, "service", short)
	b.add(svc)

	var clientIface *types.TypeName
	if o, ok := p.Types.Scope().Lookup(strings.TrimSuffix(d.handler, "Server") + "Client").(*types.TypeName); ok {
		clientIface = o
	}

	rpcIDs := map[string]string{}
	for _, r := range d.methods {
		mo, _, _ := types.LookupFieldOrMethod(obj.Type(), false, p.Types, r.name)
		fn, ok := mo.(*types.Func)
		if !ok {
			continue
		}
		req, resp := rpcTypes(fn.Type().(*types.Signature), r)
		stream := "unary"
		switch {
		case r.client && r.server:
			stream = "bidi"
		case r.server:
			stream = "server"
		case r.client:
			stream = "client"
		}
		reqName, respName := shortType(req), shortType(resp)
		if r.client {
			reqName = "stream " + reqName
		}
		if r.server {
			respName = "stream " + respName
		}
		rn := &Node{
			ID: id + "." + r.name, Kind: "rpc", Name: r.name, Parent: id, Pkg: p.PkgPath, Exported: true,
			Stream: stream, Sig: "(" + reqName + ") → " + respName,
			File: svc.File, Line: svc.Line, EndLine: svc.Line,
		}
		b.setProtoLoc(rn, d.metadata, "rpc", r.name)
		b.add(rn)
		rpcIDs[r.name] = rn.ID
		if req != nil {
			if mid := b.ensureMessage(req, true); mid != "" {
				b.addEdge(rn.ID, mid, "grpc", "request", nil)
			}
		}
		if resp != nil {
			label := "response"
			if r.server {
				label = "stream"
			}
			if mid := b.ensureMessage(resp, true); mid != "" {
				b.addEdge(rn.ID, mid, "grpc", label, nil)
			}
		}
		if clientIface != nil {
			if co, _, _ := types.LookupFieldOrMethod(clientIface.Type(), false, p.Types, r.name); co != nil {
				if cf, ok := co.(*types.Func); ok {
					b.clientRPC[cf] = rn.ID
				}
			}
		}
	}

	// handlers: module types that implement the generated server interface
	for tn, tid := range b.typeIDs {
		if n := b.nodes[tid]; n == nil || n.Kind == "message" || n.Kind == "interface" {
			continue
		}
		named, ok := tn.Type().(*types.Named)
		if !ok || (named.TypeParams() != nil && named.TypeParams().Len() > 0) {
			continue
		}
		pt := types.NewPointer(named)
		if !types.Implements(pt, iface) && !types.Implements(named, iface) {
			continue
		}
		for name, rid := range rpcIDs {
			mo, _, _ := types.LookupFieldOrMethod(pt, true, p.Types, name)
			if fn, ok := mo.(*types.Func); ok {
				if hid := b.funcIDs[fn.Origin()]; hid != "" { // declared in the module, not Unimplemented*
					b.addEdge(hid, rid, "grpc", "serves", nil)
				}
			}
		}
	}
}

func isMessage(named *types.Named) bool {
	if _, ok := named.Underlying().(*types.Struct); !ok {
		return false
	}
	return types.NewMethodSet(types.NewPointer(named)).Lookup(nil, "ProtoReflect") != nil
}

// parseProtoTag reads `protobuf:"varint,1,opt,name=object_id,json=objectId,proto3"`.
func parseProtoTag(tag string, t types.Type) (name string, num int, label string) {
	parts := strings.Split(tag, ",")
	if len(parts) > 1 {
		num, _ = strconv.Atoi(parts[1])
	}
	if len(parts) > 2 {
		switch parts[2] {
		case "rep":
			label = "repeated"
		case "opt":
			if p, ok := types.Unalias(t).(*types.Pointer); ok {
				if _, basic := p.Elem().Underlying().(*types.Basic); basic {
					label = "optional"
				}
			}
		}
	}
	for _, p := range parts {
		if v, ok := strings.CutPrefix(p, "name="); ok {
			name = v
		}
	}
	return
}

// ensureMessage creates (once) a node for a protobuf message type and,
// for messages of this module, its fields and nested-message edges.
func (b *builder) ensureMessage(t types.Type, allowExternal bool) string {
	t = types.Unalias(t)
	if p, ok := t.(*types.Pointer); ok {
		t = types.Unalias(p.Elem())
	}
	named, ok := t.(*types.Named)
	if !ok {
		return ""
	}
	tn := named.Origin().Obj()
	if id, ok := b.msgIDs[tn]; ok {
		return id
	}
	if tn.Pkg() == nil || !isMessage(named) {
		return ""
	}
	inModule := b.pkgs[tn.Pkg().Path()] || b.extraPkgs[tn.Pkg().Path()]
	if !inModule && !allowExternal {
		return ""
	}
	id := tn.Pkg().Path() + "." + tn.Name()
	b.msgIDs[tn] = id
	b.typeIDs[tn] = id
	n := b.nodes[id]
	if n == nil {
		n = &Node{ID: id}
		b.add(n)
	}
	start := b.pos(tn.Pos())
	*n = Node{
		ID: id, Kind: "message", Name: tn.Name(), Pkg: tn.Pkg().Path(), Exported: true,
		File: start.File, Line: start.Line, EndLine: start.Line, Doc: b.genDocs[tn],
	}
	if src := b.pbSource[b.fset.Position(tn.Pos()).Filename]; src != "" {
		b.setProtoLoc(n, src, "message", tn.Name())
	}
	if !inModule {
		return id
	}

	st := named.Underlying().(*types.Struct)
	q := qualifier(tn.Pkg())
	clean := func(t types.Type) string { return strings.ReplaceAll(types.TypeString(t, q), "*", "") }
	nested := func(fieldName string, ft types.Type) {
		namedIn(ft, func(x *types.TypeName) {
			if mid := b.ensureMessage(x.Type(), false); mid != "" && mid != id {
				b.addEdge(id, mid, "grpc", fieldName, nil)
			}
		}, map[types.Type]bool{})
	}
	docs := b.genFieldDocs[tn]
	for i := 0; i < st.NumFields(); i++ {
		f := st.Field(i)
		if !f.Exported() {
			continue
		}
		tag := reflect.StructTag(st.Tag(i))
		if oneof := tag.Get("protobuf_oneof"); oneof != "" {
			// variants: package types implementing the oneof interface
			oi, ok := f.Type().Underlying().(*types.Interface)
			if !ok {
				continue
			}
			scope := tn.Pkg().Scope()
			for _, nm := range scope.Names() {
				wo, ok := scope.Lookup(nm).(*types.TypeName)
				if !ok {
					continue
				}
				ws, ok := wo.Type().Underlying().(*types.Struct)
				if !ok || ws.NumFields() != 1 || !types.Implements(types.NewPointer(wo.Type()), oi) {
					continue
				}
				wf := ws.Field(0)
				pname, num, _ := parseProtoTag(reflect.StructTag(ws.Tag(0)).Get("protobuf"), wf.Type())
				n.Fields = append(n.Fields, Field{
					Name: wf.Name(), Type: clean(wf.Type()), Proto: pname, Num: num, Label: "oneof " + oneof,
					Exported: true, Line: b.pos(wf.Pos()).Line,
				})
				nested(wf.Name(), wf.Type())
			}
			continue
		}
		pt := tag.Get("protobuf")
		if pt == "" {
			continue
		}
		pname, num, label := parseProtoTag(pt, f.Type())
		if tag.Get("protobuf_key") != "" {
			label = "map"
		}
		n.Fields = append(n.Fields, Field{
			Name: f.Name(), Type: clean(f.Type()), Proto: pname, Num: num, Label: label,
			Exported: true, Line: b.pos(f.Pos()).Line, Doc: docs[f.Name()],
		})
		nested(f.Name(), f.Type())
	}
	// field lines inside the .proto message, so "open source" lands on them
	if strings.HasSuffix(n.File, ".proto") {
		lines := b.protos.fileLines(filepath.Join(b.root, filepath.FromSlash(n.File)))
		for i := range n.Fields {
			f := &n.Fields[i]
			f.Line = n.Line
			re := regexp.MustCompile(`\b` + regexp.QuoteMeta(f.Proto) + `\s*=\s*` + strconv.Itoa(f.Num) + `\b`)
			for l := n.Line; l <= n.EndLine && l <= len(lines); l++ {
				if re.MatchString(lines[l-1]) {
					f.Line = l
					break
				}
			}
		}
	}
	return id
}
