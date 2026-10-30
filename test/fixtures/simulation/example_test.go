package simulation

import "testing"

func TestCompoundMutation(t *testing.T) {
	c := &Counter{Value: 10}
	if got := c.Compound(); got != 6 {
		t.Fatalf("Compound() = %d, want 6", got)
	}
}
