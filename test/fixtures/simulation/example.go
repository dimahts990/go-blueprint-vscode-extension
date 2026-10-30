package simulation

type Counter struct {
	Value  int
	Active bool
	Label  string
}

func (c *Counter) Add(delta int) int {
	c.Value += delta
	return c.Value
}

func (c Counter) Copy(delta int) int {
	c.Value += delta
	return c.Value
}

func (c *Counter) Work(n int) int {
	for i := 0; i < n; i++ {
		if i == 2 {
			continue
		}
		if i == 4 {
			break
		}
		c.Add(i)
	}
	return c.Value
}

func (c Counter) WorkOnCopy(n int) int {
	c.Add(n)
	return c.Value
}

func Swap(a, b int) int {
	a, b = b, a
	return a*10 + b
}

func Shadow(x int) int {
	if x > 0 {
		x := 7
		x++
	}
	return x
}

func Unsupported() int {
	x := []int{1}
	return x[0]
}

func Branch(flag bool) int {
	if flag {
		return Unsupported()
	}
	return 4
}

func Factorial(n int) int {
	if n <= 1 {
		return 1
	}
	return n * Factorial(n-1)
}

func Infinite() int {
	for {
	}
}

func (c *Counter) Mutate() int {
	c.Value = 5
	return 1
}

func (c *Counter) Compound() int {
	c.Value += c.Mutate()
	return c.Value
}

func (c *Counter) Conflicting() int {
	return c.Value + c.Mutate()
}

func (c *Counter) ConflictingReturns() (int, int) {
	return c.Value, c.Mutate()
}

func (c Counter) ValueAfterArg(n int) int {
	return c.Value
}

func (c *Counter) ConflictingReceiver() int {
	return c.ValueAfterArg(c.Add(1))
}

func Empty() {}
