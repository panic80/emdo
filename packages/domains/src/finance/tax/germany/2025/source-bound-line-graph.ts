import type { Exact } from './exact.js';

/** One emitted paper line and the reviewed inputs that can change it. */
export type SourceBoundLine = {
  formId: string;
  line: string;
  value: Exact;
  dependsOn: readonly string[];
  sourceFactKeys: readonly string[];
  referenceIds: readonly string[];
};

/**
 * Small immutable-at-the-boundary dependency graph for German paper lines.
 *
 * A line may depend on other lines. The graph expands those dependencies to
 * their original reviewed facts, so a copied value cannot lose provenance.
 * It does not accept unbound defaults: every dependency must already exist.
 */
export class SourceBoundLineGraph {
  readonly #values = new Map<string, Exact>();
  readonly #origins = new Map<string, readonly string[]>();
  readonly #lines: SourceBoundLine[] = [];

  add(
    formId: string,
    line: string,
    value: Exact,
    dependsOn: readonly string[] = [],
    directFacts: readonly string[] = [],
    referenceIds: readonly string[] = [],
  ): Exact {
    const key = `${formId}.${line}`;
    if (this.#values.has(key)) throw new Error(`Duplicate graph line: ${key}`);
    for (const dependency of dependsOn)
      if (!this.#values.has(dependency))
        throw new Error(`Missing graph dependency: ${dependency}`);
    const sourceFactKeys = [
      ...new Set([
        ...directFacts,
        ...dependsOn.flatMap(
          (dependency) => this.#origins.get(dependency) ?? [],
        ),
      ]),
    ].sort();
    const normalizedReferences = [...new Set(referenceIds)].sort();
    if (normalizedReferences.length === 0)
      throw new Error(`Missing authority references: ${key}`);
    this.#values.set(key, value);
    this.#origins.set(key, sourceFactKeys);
    this.#lines.push({
      formId,
      line,
      value,
      dependsOn: [...dependsOn],
      sourceFactKeys,
      referenceIds: normalizedReferences,
    });
    return value;
  }

  get(key: string): Exact {
    const value = this.#values.get(key);
    if (!value) throw new Error(`Missing graph line: ${key}`);
    return value;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  origins(key: string): readonly string[] {
    return this.#origins.get(key) ?? [];
  }

  lines(): readonly SourceBoundLine[] {
    return this.#lines;
  }
}
