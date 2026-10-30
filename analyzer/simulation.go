package main

// A deliberately conservative representation for symbolic evaluation. Unknown
// constructs remain in the program so an untaken branch need not block a run.
import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"strconv"
	"unicode/utf8"

	"golang.org/x/tools/go/packages"
)

type SimParam struct {
	Name  string    `json:"name"`
	Type  string    `json:"type"`
	ID    string    `json:"id"`
	Shape *SimShape `json:"shape,omitempty"`
}

// SimShape describes inputs for the UI; it does not imply executable support.
type SimShape struct {
	Kind   string     `json:"kind"`
	Type   string     `json:"type"`
	Fields []SimParam `json:"fields,omitempty"`
	Elem   *SimShape  `json:"elem,omitempty"`
	Key    *SimShape  `json:"key,omitempty"`
	Length int64      `json:"length,omitempty"`
}

type SimReceiver struct {
	Name    string     `json:"name"`
	Type    string     `json:"type"`
	ID      string     `json:"id"`
	Pointer bool       `json:"pointer"`
	Fields  []SimParam `json:"fields"`
	Shape   *SimShape  `json:"shape,omitempty"`
}

func newShapeBudget() *int { n := 200; return &n }

func inputShape(t types.Type, q types.Qualifier, seen map[types.Type]bool, depth int, budget *int) *SimShape {
	if t == nil {
		return &SimShape{Kind: "unknown", Type: "?"}
	}
	s := &SimShape{Type: types.TypeString(t, q), Kind: "unknown"}
	if depth >= 6 || seen[t] || *budget <= 0 {
		s.Kind = "recursive"
		return s
	}
	*budget--
	seen[t] = true
	defer delete(seen, t)
	switch u := t.Underlying().(type) {
	case *types.Basic:
		switch {
		case u.Info()&types.IsBoolean != 0:
			s.Kind = "bool"
		case u.Info()&types.IsString != 0:
			s.Kind = "string"
		case u.Info()&types.IsInteger != 0:
			s.Kind = "int"
		case u.Info()&types.IsFloat != 0:
			s.Kind = "float"
		}
	case *types.Pointer:
		s.Kind = "pointer"
		s.Elem = inputShape(u.Elem(), q, seen, depth+1, budget)
	case *types.Slice:
		s.Kind = "slice"
		s.Elem = inputShape(u.Elem(), q, seen, depth+1, budget)
	case *types.Array:
		s.Kind = "array"
		s.Length = u.Len()
		s.Elem = inputShape(u.Elem(), q, seen, depth+1, budget)
	case *types.Map:
		s.Kind = "map"
		s.Key = inputShape(u.Key(), q, seen, depth+1, budget)
		s.Elem = inputShape(u.Elem(), q, seen, depth+1, budget)
	case *types.Struct:
		s.Kind = "struct"
		for i := 0; i < u.NumFields() && i < 50; i++ {
			f := u.Field(i)
			if f.Name() == "_" {
				continue
			}
			s.Fields = append(s.Fields, SimParam{Name: f.Name(), Type: types.TypeString(f.Type(), q), Shape: inputShape(f.Type(), q, seen, depth+1, budget)})
		}
	}
	return s
}

type SimExpr struct {
	Kind     string      `json:"kind"`
	Name     string      `json:"name,omitempty"`
	Op       string      `json:"op,omitempty"`
	Value    interface{} `json:"value,omitempty"`
	Args     []*SimExpr  `json:"args,omitempty"`
	Receiver *SimExpr    `json:"receiver,omitempty"`
}

type SimStmt struct {
	Kind    string     `json:"kind"`
	Op      string     `json:"op,omitempty"`
	Targets []*SimExpr `json:"targets,omitempty"`
	Args    []*SimExpr `json:"args,omitempty"`
	Cond    *SimExpr   `json:"cond,omitempty"`
	Init    *SimStmt   `json:"init,omitempty"`
	Post    *SimStmt   `json:"post,omitempty"`
	Body    []*SimStmt `json:"body,omitempty"`
	Else    []*SimStmt `json:"else,omitempty"`
}

type Simulation struct {
	Params      []SimParam   `json:"params"`
	Receiver    *SimReceiver `json:"receiver,omitempty"`
	ResultCount int          `json:"resultCount"`
	Body        []*SimStmt   `json:"body,omitempty"`
	// Retained for compatibility with graphs consumed by older webviews.
	Results   []*SimExpr `json:"results,omitempty"`
	Supported bool       `json:"supported"`
}

func simType(t types.Type) string {
	if basic, ok := t.(*types.Basic); ok {
		switch basic.Kind() {
		case types.Bool:
			return "bool"
		case types.String:
			return "string"
		case types.Int:
			return "int"
		}
	}
	return ""
}

func simID(v *types.Var) string {
	name := v.Name()
	if name == "" || name == "_" {
		name = "receiver"
	}
	return fmt.Sprintf("%s@%d", name, v.Pos())
}

func (b *builder) simulations(p *packages.Package) {
	for _, f := range b.files(p) {
		for _, decl := range f.Decls {
			d, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			fn, _ := p.TypesInfo.Defs[d.Name].(*types.Func)
			if fn == nil {
				continue
			}
			n := b.nodes[b.funcIDs[fn]]
			if n == nil {
				continue
			}
			sig := fn.Type().(*types.Signature)
			s := &Simulation{Params: []SimParam{}, ResultCount: sig.Results().Len()}
			n.Simulation = s
			vars := map[*types.Var]string{}
			valid := !sig.Variadic() && sig.TypeParams().Len() == 0
			for i := 0; i < sig.Params().Len(); i++ {
				v := sig.Params().At(i)
				t := simType(v.Type())
				name := v.Name()
				if name == "" || name == "_" {
					name = "arg" + strconv.Itoa(i+1)
				}
				if t == "" {
					valid = false
					t = types.TypeString(v.Type(), qualifier(p.Types))
				}
				id := simID(v)
				vars[v] = id
				s.Params = append(s.Params, SimParam{Name: name, Type: t, ID: id, Shape: inputShape(v.Type(), qualifier(p.Types), map[types.Type]bool{}, 0, newShapeBudget())})
			}
			for i := 0; i < sig.Results().Len(); i++ {
				if simType(sig.Results().At(i).Type()) == "" {
					valid = false
				}
			}
			var recv *types.Var
			if recv = sig.Recv(); recv != nil {
				r := &SimReceiver{Name: recv.Name(), Type: types.TypeString(recv.Type(), qualifier(p.Types)), ID: simID(recv), Fields: []SimParam{}, Shape: inputShape(recv.Type(), qualifier(p.Types), map[types.Type]bool{}, 0, newShapeBudget())}
				if r.Name == "" || r.Name == "_" {
					r.Name = "receiver"
				}
				t := recv.Type()
				if ptr, ok := t.(*types.Pointer); ok {
					r.Pointer = true
					t = ptr.Elem()
				}
				st, ok := t.Underlying().(*types.Struct)
				if !ok {
					valid = false
				} else {
					for i := 0; i < st.NumFields(); i++ {
						field := st.Field(i)
						ft := simType(field.Type())
						if ft == "" || field.Embedded() || field.Name() == "_" {
							valid = false
						}
						if ft == "" {
							ft = types.TypeString(field.Type(), qualifier(p.Types))
						}
						r.Fields = append(r.Fields, SimParam{Name: field.Name(), Type: ft, Shape: inputShape(field.Type(), qualifier(p.Types), map[types.Type]bool{}, 0, newShapeBudget())})
					}
				}
				s.Receiver = r
				vars[recv] = r.ID
			}
			if d.Body == nil || !valid {
				continue
			}
			// Function-scoped object IDs are distinct even when source names shadow.
			ast.Inspect(d.Body, func(node ast.Node) bool {
				if _, ok := node.(*ast.FuncLit); ok {
					return false
				}
				id, ok := node.(*ast.Ident)
				if !ok {
					return true
				}
				v, ok := p.TypesInfo.Defs[id].(*types.Var)
				if ok && v.Name() != "_" && simType(v.Type()) != "" {
					vars[v] = simID(v)
				}
				return true
			})
			c := simCompiler{b: b, info: p.TypesInfo, vars: vars, recv: recv, resultCount: sig.Results().Len()}
			s.Body = c.block(d.Body)
			s.Supported = true
			if len(s.Body) == 1 && s.Body[0].Kind == "return" {
				s.Results = s.Body[0].Args
			}
		}
	}
}

type simCompiler struct {
	b           *builder
	info        *types.Info
	vars        map[*types.Var]string
	recv        *types.Var
	resultCount int
}

func (c *simCompiler) exprs(list []ast.Expr) []*SimExpr {
	out := make([]*SimExpr, 0, len(list))
	for _, e := range list {
		out = append(out, c.expr(e))
	}
	return out
}

func unknownExpr() *SimExpr { return &SimExpr{Kind: "unknown"} }

func (c *simCompiler) expr(expr ast.Expr) *SimExpr {
	if expr == nil {
		return unknownExpr()
	}
	expr = unparen(expr)
	if tv, ok := c.info.Types[expr]; ok && tv.Value != nil {
		switch tv.Value.Kind() {
		case constant.Bool:
			return &SimExpr{Kind: "literal", Value: constant.BoolVal(tv.Value)}
		case constant.String:
			value := constant.StringVal(tv.Value)
			if utf8.ValidString(value) {
				return &SimExpr{Kind: "literal", Value: value}
			}
		case constant.Int:
			if n, ok := constant.Int64Val(tv.Value); ok && n >= -2147483648 && n <= 2147483647 {
				return &SimExpr{Kind: "literal", Value: n}
			}
		}
		return unknownExpr()
	}
	switch x := expr.(type) {
	case *ast.BinaryExpr:
		switch x.Op {
		case token.ADD, token.SUB, token.MUL, token.QUO, token.REM, token.EQL, token.NEQ, token.LSS, token.LEQ, token.GTR, token.GEQ, token.LAND, token.LOR:
		default:
			return unknownExpr()
		}
		if simType(c.info.TypeOf(x.X)) == "" || simType(c.info.TypeOf(x.Y)) == "" {
			return unknownExpr()
		}
		return &SimExpr{Kind: "binary", Op: x.Op.String(), Args: []*SimExpr{c.expr(x.X), c.expr(x.Y)}}
	case *ast.UnaryExpr:
		if (x.Op != token.NOT && x.Op != token.SUB && x.Op != token.ADD) || simType(c.info.TypeOf(x.X)) == "" {
			return unknownExpr()
		}
		return &SimExpr{Kind: "unary", Op: x.Op.String(), Args: []*SimExpr{c.expr(x.X)}}
	case *ast.Ident:
		v, _ := c.info.Uses[x].(*types.Var)
		if v == nil {
			v, _ = c.info.Defs[x].(*types.Var)
		}
		if id := c.vars[v]; id != "" {
			return &SimExpr{Kind: "param", Name: id}
		}
	case *ast.SelectorExpr:
		if c.receiverIdent(x.X) {
			sel := c.info.Selections[x]
			if sel != nil && sel.Kind() == types.FieldVal && len(sel.Index()) == 1 && simType(sel.Obj().Type()) != "" {
				return &SimExpr{Kind: "field", Name: x.Sel.Name, Args: []*SimExpr{c.expr(x.X)}}
			}
		}
	case *ast.CallExpr:
		if x.Ellipsis != token.NoPos {
			return unknownExpr()
		}
		var id *ast.Ident
		var receiver *SimExpr
		switch f := unparen(x.Fun).(type) {
		case *ast.Ident:
			id = f
		case *ast.SelectorExpr:
			id = f.Sel
			if sel := c.info.Selections[f]; sel != nil {
				if sel.Kind() != types.MethodVal || !c.receiverIdent(f.X) {
					return unknownExpr()
				}
				receiver = c.expr(f.X)
			}
		}
		if id == nil {
			return unknownExpr()
		}
		fn, ok := c.info.Uses[id].(*types.Func)
		if !ok {
			return unknownExpr()
		}
		sig := fn.Type().(*types.Signature)
		if (sig.Recv() != nil) != (receiver != nil) || sig.Results().Len() > 1 {
			return unknownExpr()
		}
		target := c.b.funcID(fn)
		if target == "" {
			return unknownExpr()
		}
		return &SimExpr{Kind: "call", Name: target, Args: c.exprs(x.Args), Receiver: receiver}
	}
	return unknownExpr()
}

func (c *simCompiler) receiverIdent(e ast.Expr) bool {
	id, ok := unparen(e).(*ast.Ident)
	return ok && c.recv != nil && c.info.Uses[id] == c.recv
}

func (c *simCompiler) block(block *ast.BlockStmt) []*SimStmt {
	out := []*SimStmt{}
	if block != nil {
		for _, s := range block.List {
			out = append(out, c.stmt(s))
		}
	}
	return out
}

func (c *simCompiler) stmt(stmt ast.Stmt) *SimStmt {
	if stmt == nil {
		return nil
	}
	switch x := stmt.(type) {
	case *ast.BlockStmt:
		return &SimStmt{Kind: "block", Body: c.block(x)}
	case *ast.EmptyStmt:
		return &SimStmt{Kind: "block"}
	case *ast.ReturnStmt:
		if len(x.Results) != c.resultCount {
			return &SimStmt{Kind: "unknown"}
		}
		return &SimStmt{Kind: "return", Args: c.exprs(x.Results)}
	case *ast.AssignStmt:
		op := ""
		switch x.Tok {
		case token.ASSIGN:
			op = "="
		case token.DEFINE:
			op = ":="
		case token.ADD_ASSIGN:
			op = "+"
		case token.SUB_ASSIGN:
			op = "-"
		case token.MUL_ASSIGN:
			op = "*"
		case token.QUO_ASSIGN:
			op = "/"
		case token.REM_ASSIGN:
			op = "%"
		default:
			return &SimStmt{Kind: "unknown"}
		}
		if len(x.Lhs) != len(x.Rhs) {
			return &SimStmt{Kind: "unknown"}
		}
		targets := c.exprs(x.Lhs)
		for _, t := range targets {
			if t.Kind != "param" && t.Kind != "field" {
				return &SimStmt{Kind: "unknown"}
			}
		}
		return &SimStmt{Kind: "assign", Op: op, Targets: targets, Args: c.exprs(x.Rhs)}
	case *ast.IncDecStmt:
		target := c.expr(x.X)
		if target.Kind != "param" && target.Kind != "field" {
			return &SimStmt{Kind: "unknown"}
		}
		op := "+"
		if x.Tok == token.DEC {
			op = "-"
		}
		return &SimStmt{Kind: "assign", Op: op, Targets: []*SimExpr{target}, Args: []*SimExpr{{Kind: "literal", Value: 1}}}
	case *ast.IfStmt:
		out := &SimStmt{Kind: "if", Init: c.stmt(x.Init), Cond: c.expr(x.Cond), Body: c.block(x.Body)}
		if x.Else != nil {
			if e, ok := x.Else.(*ast.BlockStmt); ok {
				out.Else = c.block(e)
			} else {
				out.Else = []*SimStmt{c.stmt(x.Else)}
			}
		}
		return out
	case *ast.ForStmt:
		out := &SimStmt{Kind: "for", Init: c.stmt(x.Init), Post: c.stmt(x.Post), Body: c.block(x.Body)}
		if x.Cond != nil {
			out.Cond = c.expr(x.Cond)
		}
		return out
	case *ast.BranchStmt:
		if x.Label != nil {
			return &SimStmt{Kind: "unknown"}
		}
		if x.Tok == token.BREAK {
			return &SimStmt{Kind: "break"}
		}
		if x.Tok == token.CONTINUE {
			return &SimStmt{Kind: "continue"}
		}
	case *ast.ExprStmt:
		if _, ok := x.X.(*ast.CallExpr); ok {
			return &SimStmt{Kind: "expr", Args: []*SimExpr{c.expr(x.X)}}
		}
	case *ast.DeclStmt:
		d, ok := x.Decl.(*ast.GenDecl)
		if !ok || d.Tok != token.VAR {
			return &SimStmt{Kind: "unknown"}
		}
		var stmts []*SimStmt
		for _, spec := range d.Specs {
			v, ok := spec.(*ast.ValueSpec)
			if !ok {
				return &SimStmt{Kind: "unknown"}
			}
			targets := make([]*SimExpr, 0, len(v.Names))
			args := c.exprs(v.Values)
			if len(args) != 0 && len(args) != len(v.Names) {
				return &SimStmt{Kind: "unknown"}
			}
			for _, name := range v.Names {
				obj, _ := c.info.Defs[name].(*types.Var)
				if obj == nil || c.vars[obj] == "" {
					return &SimStmt{Kind: "unknown"}
				}
				targets = append(targets, &SimExpr{Kind: "param", Name: c.vars[obj]})
				if len(v.Values) == 0 {
					var zero interface{}
					switch simType(obj.Type()) {
					case "int":
						zero = 0
					case "bool":
						zero = false
					case "string":
						zero = ""
					default:
						return &SimStmt{Kind: "unknown"}
					}
					args = append(args, &SimExpr{Kind: "literal", Value: zero})
				}
			}
			stmts = append(stmts, &SimStmt{Kind: "assign", Op: ":=", Targets: targets, Args: args})
		}
		return &SimStmt{Kind: "block", Body: stmts}
	}
	return &SimStmt{Kind: "unknown"}
}
