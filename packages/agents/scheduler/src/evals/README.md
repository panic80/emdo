# Scheduler deterministic evals

The MVP eval cases lock timezone gaps/overlaps, private-calendar masking,
travel fallback, and exact provider readback behavior. They run entirely over
synthetic recorded fixtures. Provider conformance and live smoke tests remain a
separate release gate.
