package main

// A small .proto parser: services, RPCs and messages straight from .proto
// files, for modules that have no generated Go code (or protos whose code
// lives elsewhere). Generated code, when present, always wins.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type ptok struct {
	s    string
	line int
	doc  string // comment block right above the token
}

type pField struct {
	name, typ, label string
	num, line        int
	doc              string
}

type pMessage struct {
	full, name string // full: pkg.Outer.Inner, name: Outer.Inner
	line, end  int
	fields     []pField
	doc        string
}

type pRPC struct {
	name, req, resp       string
	reqStream, respStream bool
	line, end             int
	doc                   string
}

type pService struct {
	name      string
	line, end int
	rpcs      []pRPC
	doc       string
}

type pFile struct {
	path     string
	pkg      string
	services []pService
	messages []pMessage
	enums    map[string]bool
}

// tokenize splits proto source into identifiers/numbers/strings/symbols,
// remembering the comment block that precedes each token.
func tokenize(src string) []ptok {
	var toks []ptok
	line := 1
	var doc []string
	docEnd := 0
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			j := strings.IndexByte(src[i:], '\n')
			if j < 0 {
				j = len(src) - i
			}
			if len(toks) > 0 && toks[len(toks)-1].line == line {
				i += j // trailing comment of a statement: not a doc for the next one
				continue
			}
			if docEnd < line-1 {
				doc = nil
			}
			doc = append(doc, strings.TrimSpace(src[i+2:i+j]))
			docEnd = line
			i += j
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			j := strings.Index(src[i+2:], "*/")
			if j < 0 {
				j = len(src) - i - 2
			}
			body := src[i+2 : i+2+j]
			doc = []string{strings.TrimSpace(strings.Trim(body, "* \n"))}
			line += strings.Count(body, "\n")
			docEnd = line
			i += j + 4
		case c == '"' || c == '\'':
			j := i + 1
			for j < len(src) && src[j] != c {
				if src[j] == '\\' {
					j++
				}
				j++
			}
			toks = append(toks, ptok{s: src[i:min(j+1, len(src))], line: line})
			i = j + 1
		case isIdent(c) || c == '.' || (c >= '0' && c <= '9') || c == '-':
			j := i
			for j < len(src) && (isIdent(src[j]) || src[j] == '.' || (src[j] >= '0' && src[j] <= '9') || src[j] == '-') {
				j++
			}
			t := ptok{s: src[i:j], line: line}
			if docEnd >= line-1 && len(doc) > 0 {
				t.doc = strings.Join(doc, "\n")
			}
			doc = nil
			toks = append(toks, t)
			i = j
		default:
			toks = append(toks, ptok{s: string(c), line: line})
			i++
		}
	}
	return toks
}

func isIdent(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

type pparser struct {
	t []ptok
	i int
	f *pFile
}

func (p *pparser) peek() string {
	if p.i < len(p.t) {
		return p.t[p.i].s
	}
	return ""
}

func (p *pparser) next() ptok {
	if p.i < len(p.t) {
		p.i++
		return p.t[p.i-1]
	}
	return ptok{}
}

// skipStatement consumes up to and including ';', or a whole {...} block.
func (p *pparser) skipStatement() {
	for p.i < len(p.t) {
		switch p.next().s {
		case ";":
			return
		case "{":
			p.skipBlock()
			return
		}
	}
}

// skipBlock consumes until the '}' matching an already consumed '{'.
func (p *pparser) skipBlock() int {
	depth := 1
	for p.i < len(p.t) {
		t := p.next()
		switch t.s {
		case "{":
			depth++
		case "}":
			depth--
			if depth == 0 {
				return t.line
			}
		}
	}
	return 0
}

func parseProtoFile(path string) *pFile {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	p := &pparser{t: tokenize(string(data)), f: &pFile{path: path, enums: map[string]bool{}}}
	for p.i < len(p.t) {
		t := p.next()
		switch t.s {
		case "package":
			p.f.pkg = p.next().s
			p.skipStatement()
		case "message":
			p.message(t, "")
		case "enum":
			name := p.next().s
			p.f.enums[name] = true
			if p.peek() == "{" {
				p.next()
				p.skipBlock()
			}
		case "service":
			p.service(t)
		case "syntax", "import", "option", "edition":
			p.skipStatement()
		case "extend":
			p.next()
			if p.peek() == "{" {
				p.next()
				p.skipBlock()
			}
		}
	}
	return p.f
}

func (p *pparser) message(kw ptok, outer string) {
	name := p.next().s
	if p.peek() != "{" {
		return
	}
	p.next()
	short := name
	if outer != "" {
		short = outer + "." + name
	}
	m := pMessage{name: short, line: kw.line, doc: kw.doc}
	m.full = short
	if p.f.pkg != "" {
		m.full = p.f.pkg + "." + short
	}
	oneof := ""
	for p.i < len(p.t) {
		t := p.next()
		switch t.s {
		case "}":
			if oneof != "" {
				oneof = ""
				continue
			}
			m.end = t.line
			p.f.messages = append(p.f.messages, m)
			return
		case "message":
			p.message(t, short)
		case "enum":
			en := p.next().s
			p.f.enums[short+"."+en] = true
			if p.peek() == "{" {
				p.next()
				p.skipBlock()
			}
		case "oneof":
			oneof = p.next().s
			if p.peek() == "{" {
				p.next()
			}
		case "option", "reserved", "extensions":
			p.skipStatement()
		case "extend":
			p.next()
			if p.peek() == "{" {
				p.next()
				p.skipBlock()
			}
		case ";":
		default:
			f := pField{line: t.line, doc: t.doc}
			typ := t.s
			switch typ {
			case "repeated", "optional", "required":
				f.label = typ
				if typ == "required" {
					f.label = ""
				}
				typ = p.next().s
			}
			if typ == "map" && p.peek() == "<" {
				p.next()
				k := p.next().s
				p.next() // ,
				v := p.next().s
				p.next() // >
				typ, f.label = v, "map"
				f.typ = "map<" + k + ", " + v + ">"
			}
			if f.typ == "" {
				f.typ = typ
			}
			f.name = p.next().s
			if p.peek() == "=" {
				p.next()
				f.num, _ = strconv.Atoi(p.next().s)
			}
			if oneof != "" {
				f.label = "oneof " + oneof
			}
			p.skipStatement()
			if f.name != "" && f.num > 0 {
				f.typ = strings.TrimSpace(f.typ)
				// keep the value type for resolving map<K, V> fields
				if f.label == "map" {
					f.typ = f.typ + "|" + typ
				}
				m.fields = append(m.fields, f)
			}
		}
	}
}

func (p *pparser) service(kw ptok) {
	s := pService{name: p.next().s, line: kw.line, doc: kw.doc}
	if p.peek() != "{" {
		return
	}
	p.next()
	for p.i < len(p.t) {
		t := p.next()
		switch t.s {
		case "}":
			s.end = t.line
			p.f.services = append(p.f.services, s)
			return
		case "rpc":
			r := pRPC{name: p.next().s, line: t.line, end: t.line, doc: t.doc}
			p.next() // (
			if p.peek() == "stream" {
				p.next()
				r.reqStream = true
			}
			r.req = p.next().s
			p.next() // )
			if p.peek() == "returns" {
				p.next()
			}
			p.next() // (
			if p.peek() == "stream" {
				p.next()
				r.respStream = true
			}
			r.resp = p.next().s
			p.next() // )
			if p.peek() == "{" {
				p.next()
				r.end = p.skipBlock()
			} else if p.peek() == ";" {
				p.next()
			}
			s.rpcs = append(s.rpcs, r)
		case "option":
			p.skipStatement()
		}
	}
}

// ---------------------------------------------------------------- graph

// protoOnlyLayer adds services/messages from .proto files that have no
// generated Go code in the loaded packages.
func (b *builder) protoOnlyLayer() {
	covered := map[string]bool{}
	for _, src := range b.pbSource {
		if f := b.protos.find(src); f != "" {
			covered[f] = true
		}
	}
	var files []*pFile
	for _, path := range b.protos.files {
		if covered[path] {
			continue
		}
		f := parseProtoFile(path)
		if f == nil || (len(f.services) == 0 && len(f.messages) == 0) {
			continue
		}
		skip := false
		for _, s := range f.services {
			if b.nodes["grpc:"+qualify(f.pkg, s.name)] != nil {
				skip = true // its generated code is loaded after all
			}
		}
		if !skip {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		return
	}

	msgs := map[string]*pMessage{} // full name -> message
	pkgOf := map[string]string{}
	for _, f := range files {
		for i := range f.messages {
			msgs[f.messages[i].full] = &f.messages[i]
			pkgOf[f.messages[i].full] = f.pkg
		}
	}
	// resolve a type reference written inside scope (pkg.Outer...)
	resolve := func(scope, typ string) string {
		if strings.HasPrefix(typ, ".") {
			if _, ok := msgs[typ[1:]]; ok {
				return typ[1:]
			}
			return ""
		}
		for s := scope; ; {
			cand := typ
			if s != "" {
				cand = s + "." + typ
			}
			if _, ok := msgs[cand]; ok {
				return cand
			}
			if s == "" {
				return ""
			}
			if i := strings.LastIndex(s, "."); i >= 0 {
				s = s[:i]
			} else {
				s = ""
			}
		}
	}
	msgID := func(full string) string { return "proto:" + full }
	external := func(typ string) string {
		// well-known / unresolved request & response types still get a card
		full := strings.TrimPrefix(typ, ".")
		id := msgID(full)
		if b.nodes[id] == nil {
			pkg := "proto:external"
			if i := strings.LastIndex(full, "."); i > 0 {
				pkg = "proto:" + full[:i]
			}
			b.add(&Node{ID: id, Kind: "message", Name: full[strings.LastIndex(full, ".")+1:], Pkg: pkg, Exported: true,
				Doc: full + " (определение не найдено среди .proto)"})
		}
		return id
	}

	for _, f := range files {
		rel := b.rel(f.path)
		pkg := "proto:" + f.pkg
		if f.pkg == "" {
			pkg = "proto:" + strings.TrimSuffix(filepath.Base(f.path), ".proto")
		}
		for _, m := range f.messages {
			n := &Node{ID: msgID(m.full), Kind: "message", Name: m.name, Pkg: pkg, Exported: true,
				File: rel, Line: m.line, EndLine: m.end, Doc: m.doc}
			for _, fl := range m.fields {
				typ, valueType := fl.typ, fl.typ
				if fl.label == "map" {
					parts := strings.SplitN(fl.typ, "|", 2)
					typ, valueType = parts[0], parts[1]
				}
				n.Fields = append(n.Fields, Field{Name: fl.name, Type: typ, Proto: fl.name, Num: fl.num, Label: fl.label,
					Exported: true, Line: fl.line, Doc: fl.doc})
				if target := resolve(m.full, valueType); target != "" && target != m.full {
					b.addEdge(n.ID, msgID(target), "grpc", fl.name, nil)
				}
			}
			b.add(n)
		}
		for _, s := range f.services {
			id := "grpc:" + qualify(f.pkg, s.name)
			b.add(&Node{ID: id, Kind: "service", Name: s.name, Pkg: pkg, Exported: true,
				File: rel, Line: s.line, EndLine: s.end,
				Doc: strings.TrimSpace(s.doc + "\ngRPC service " + qualify(f.pkg, s.name) + " (из .proto, без сгенерированного кода)")})
			for _, r := range s.rpcs {
				stream := "unary"
				switch {
				case r.reqStream && r.respStream:
					stream = "bidi"
				case r.respStream:
					stream = "server"
				case r.reqStream:
					stream = "client"
				}
				reqName, respName := lastPart(r.req), lastPart(r.resp)
				if r.reqStream {
					reqName = "stream " + reqName
				}
				if r.respStream {
					respName = "stream " + respName
				}
				rn := &Node{ID: id + "." + r.name, Kind: "rpc", Name: r.name, Parent: id, Pkg: pkg, Exported: true,
					Stream: stream, Sig: "(" + reqName + ") → " + respName, File: rel, Line: r.line, EndLine: r.end, Doc: r.doc}
				b.add(rn)
				scope := f.pkg
				if t := resolve(scope, r.req); t != "" {
					b.addEdge(rn.ID, msgID(t), "grpc", "request", nil)
				} else {
					b.addEdge(rn.ID, external(r.req), "grpc", "request", nil)
				}
				label := "response"
				if r.respStream {
					label = "stream"
				}
				if t := resolve(scope, r.resp); t != "" {
					b.addEdge(rn.ID, msgID(t), "grpc", label, nil)
				} else {
					b.addEdge(rn.ID, external(r.resp), "grpc", label, nil)
				}
			}
		}
	}
	b.g.Proto.FromProto = len(files)
}

func qualify(pkg, name string) string {
	if pkg == "" {
		return name
	}
	return pkg + "." + name
}

func lastPart(s string) string {
	return s[strings.LastIndex(s, ".")+1:]
}
