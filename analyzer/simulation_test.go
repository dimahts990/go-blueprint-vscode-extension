package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"testing"

	"golang.org/x/tools/go/packages"
)

func TestSimulationPrograms(t *testing.T) {
	const src = `package example
func Identity(value string) string { return value }
func Nested(value string) string { return Identity(value) }
func Constant() (bool, int) { return true, 1 + 2 }
func Add(value int) int { return value + 2 }
func Overflow() uint8 { return 255 }
func Branch(value bool) string { if value { return "yes" }; return "no" }
func Shadow(x int) int { if x > 0 { x := x + 1; return x }; return x }
func Loop(n int) int { var total int; for i := 0; i < n; i++ { if i == 2 { continue }; total += i }; return total }
func UnknownPath(value bool) int { if value { panic("bad") }; return 3 }
var global int
func Global() int { return global }
func Swap(a, b int) (int, int) { a, b = b, a; return a, b }
type T struct { N int; Label string; Active bool }
func (t *T) Update(value int) int { t.N += value; return t.N }
func (t T) Get() int { return t.N }
func (T) Anonymous() int { return 1 }
func (t *T) Invoke(value int) int { return t.Update(value) }
type Bad struct { N uint8 }
func (t *Bad) Unsupported() int { return 1 }
func External(value string) int { return len(value) }
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "example.go", src, 0)
	if err != nil {
		t.Fatal(err)
	}
	info := &types.Info{Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}, Types: map[ast.Expr]types.TypeAndValue{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
	pkg, err := (&types.Config{}).Check("example", fset, []*ast.File{file}, info)
	if err != nil {
		t.Fatal(err)
	}
	p := &packages.Package{PkgPath: "example", Types: pkg, TypesInfo: info, Syntax: []*ast.File{file}}
	b := &builder{fset: fset, root: ".", g: &Graph{}, nodes: map[string]*Node{}, funcIDs: map[*types.Func]string{}, typeIDs: map[*types.TypeName]string{}}
	b.declare(p)
	b.simulations(p)

	identity := b.nodes["example.Identity"].Simulation
	if !identity.Supported || len(identity.Params) != 1 || identity.Params[0].Name != "value" || identity.Results[0].Kind != "param" || identity.Results[0].Name != identity.Params[0].ID {
		t.Fatalf("identity: %+v", identity)
	}
	nested := b.nodes["example.Nested"].Simulation
	if !nested.Supported || nested.Results[0].Kind != "call" || nested.Results[0].Name != "example.Identity" || nested.Results[0].Args[0].Name != nested.Params[0].ID {
		t.Fatalf("nested: %+v", nested)
	}
	constant := b.nodes["example.Constant"].Simulation
	if !constant.Supported || constant.ResultCount != 2 || constant.Results[0].Value != true || constant.Results[1].Value != int64(3) {
		t.Fatalf("constant: %+v", constant)
	}
	add := b.nodes["example.Add"].Simulation
	if !add.Supported || add.Results[0].Kind != "binary" || add.Results[0].Op != "+" {
		t.Fatalf("add: %+v", add)
	}
	branch := b.nodes["example.Branch"].Simulation
	if !branch.Supported || branch.Body[0].Kind != "if" || branch.Body[0].Body[0].Kind != "return" {
		t.Fatalf("branch: %+v", branch)
	}
	shadow := b.nodes["example.Shadow"].Simulation
	inner := shadow.Body[0].Body[0]
	if inner.Kind != "assign" || inner.Targets[0].Name == shadow.Params[0].ID || inner.Args[0].Args[0].Name != shadow.Params[0].ID {
		t.Fatalf("shadow: %+v", inner)
	}
	loop := b.nodes["example.Loop"].Simulation
	if !loop.Supported || loop.Body[0].Kind != "block" || loop.Body[1].Kind != "for" || loop.Body[1].Post.Op != "+" || loop.Body[1].Body[0].Body[0].Kind != "continue" || loop.Body[1].Body[1].Op != "+" {
		t.Fatalf("loop: %+v", loop)
	}
	unknown := b.nodes["example.UnknownPath"].Simulation
	if !unknown.Supported || unknown.Body[0].Body[0].Args[0].Kind != "unknown" {
		t.Fatalf("unknown branch: %+v", unknown)
	}
	global := b.nodes["example.Global"].Simulation
	if global.Body[0].Args[0].Kind != "unknown" {
		t.Fatalf("global state must be unknown: %+v", global)
	}
	swap := b.nodes["example.Swap"].Simulation
	if swap.Body[0].Kind != "assign" || len(swap.Body[0].Targets) != 2 || swap.Body[0].Args[0].Name != swap.Params[1].ID || swap.Body[0].Args[1].Name != swap.Params[0].ID {
		t.Fatalf("parallel assignment: %+v", swap.Body[0])
	}
	update := b.nodes["example.T.Update"].Simulation
	if !update.Supported || !update.Receiver.Pointer || len(update.Receiver.Fields) != 3 || update.Body[0].Targets[0].Kind != "field" || update.Body[0].Targets[0].Args[0].Name != update.Receiver.ID {
		t.Fatalf("update: %+v", update)
	}
	get := b.nodes["example.T.Get"].Simulation
	if !get.Supported || get.Receiver.Pointer || get.Body[0].Args[0].Kind != "field" {
		t.Fatalf("get: %+v", get)
	}
	anonymous := b.nodes["example.T.Anonymous"].Simulation
	if !anonymous.Supported || anonymous.Receiver.Name != "receiver" {
		t.Fatalf("anonymous: %+v", anonymous)
	}
	invoke := b.nodes["example.T.Invoke"].Simulation
	if !invoke.Supported || invoke.Body[0].Args[0].Receiver.Name != invoke.Receiver.ID || invoke.Body[0].Args[0].Name != "example.T.Update" {
		t.Fatalf("invoke: %+v", invoke)
	}
	for _, id := range []string{"example.Overflow", "example.Bad.Unsupported"} {
		if b.nodes[id].Simulation.Supported {
			t.Errorf("%s must be unsupported", id)
		}
	}
	if b.nodes["example.External"].Simulation.Results[0].Kind != "unknown" {
		t.Error("external call must be unknown")
	}
}
