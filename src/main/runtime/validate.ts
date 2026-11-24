/** A deliberately small JSON-Schema subset: enough to reject bad arguments before a tool runs. */

export interface SchemaProp {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** Anchored nowhere: matched with `.test`, so the schema author supplies ^…$. */
  pattern?: string;
  items?: SchemaProp;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, SchemaProp>;
  required?: string[];
  default?: unknown;
}

export interface ToolSchema {
  type: 'object';
  properties: Record<string, SchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ValidationIssue {
  path: string;
  expected: string;
  actual: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(prop: SchemaProp, value: unknown): boolean {
  const actual = typeOf(value);
  if (!prop.type) return true;
  if (prop.type === 'integer') return actual === 'number' && Number.isInteger(value);
  return actual === prop.type;
}

/**
 * Validate one value against one property, recursing into arrays and objects.
 * The subset is small on purpose: the goal is to catch the failures models
 * actually make (wrong type, missing field, out-of-range number, empty string,
 * extra key, wrong element type) with a message the model can act on.
 */
function validateValue(prop: SchemaProp, value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!matchesType(prop, value)) {
    issues.push({ path, expected: prop.type ?? 'value', actual: typeOf(value) });
    return;
  }

  if (prop.enum && !prop.enum.includes(String(value))) {
    issues.push({ path, expected: `one of ${prop.enum.join(' | ')}`, actual: String(value) });
    return;
  }

  if (typeof value === 'string') {
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      issues.push({
        path,
        expected: prop.minLength === 1 ? 'a non-empty string' : `at least ${prop.minLength} characters`,
        actual: value.length === 0 ? 'empty string' : `${value.length} characters`,
      });
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      issues.push({ path, expected: `at most ${prop.maxLength} characters`, actual: `${value.length} characters` });
    }
    if (prop.pattern) {
      let pattern: RegExp | null = null;
      try {
        pattern = new RegExp(prop.pattern);
      } catch {
        pattern = null;
      }
      if (pattern && !pattern.test(value)) {
        issues.push({ path, expected: `matching ${prop.pattern}`, actual: value.slice(0, 40) });
      }
    }
  }

  if (typeof value === 'number') {
    if (prop.minimum !== undefined && value < prop.minimum) {
      issues.push({ path, expected: `>= ${prop.minimum}`, actual: String(value) });
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      issues.push({ path, expected: `<= ${prop.maximum}`, actual: String(value) });
    }
  }

  if (Array.isArray(value)) {
    if (prop.minItems !== undefined && value.length < prop.minItems) {
      issues.push({ path, expected: `at least ${prop.minItems} item(s)`, actual: `${value.length} item(s)` });
    }
    if (prop.maxItems !== undefined && value.length > prop.maxItems) {
      issues.push({ path, expected: `at most ${prop.maxItems} item(s)`, actual: `${value.length} item(s)` });
    }
    if (prop.items) {
      value.forEach((entry, index) => validateValue(prop.items!, entry, `${path}[${index}]`, issues));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value) && prop.properties) {
    const object = value as Record<string, unknown>;
    for (const key of prop.required ?? []) {
      if (object[key] === undefined || object[key] === null) {
        issues.push({ path: `${path}.${key}`, expected: 'required', actual: 'missing' });
      }
    }
    for (const [key, nested] of Object.entries(prop.properties)) {
      if (object[key] === undefined) continue;
      validateValue(nested, object[key], `${path}.${key}`, issues);
    }
  }
}

export function validate(schema: ToolSchema, value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeOf(value) !== 'object') {
    return [{ path: '$', expected: 'object', actual: typeOf(value) }];
  }
  const object = value as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (object[key] === undefined || object[key] === null) {
      issues.push({ path: key, expected: 'required', actual: 'missing' });
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (object[key] === undefined) continue;
    validateValue(prop, object[key], key, issues);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(object)) {
      if (!(key in schema.properties)) {
        issues.push({ path: key, expected: 'not an accepted argument', actual: 'unexpected' });
      }
    }
  }

  return issues;
}

export function schemaSnippet(schema: ToolSchema): string {
  return JSON.stringify({ type: schema.type, required: schema.required ?? [], properties: schema.properties }, null, 2);
}

/** One plausible argument object, used as the positive example in a retry hint. */
export function positiveExample(schema: ToolSchema): string {
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    example[key] = exampleValue(prop);
  }
  return JSON.stringify(example);
}

function exampleValue(prop: SchemaProp): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.enum && prop.enum.length > 0) return prop.enum[0];
  if (prop.type === 'string') {
    const fromDescription = prop.description?.match(/e\.g\. ([^,)]+)/)?.[1];
    if (fromDescription) return fromDescription;
    return prop.minLength !== undefined && prop.minLength > 0 ? 'value' : '';
  }
  if (prop.type === 'number' || prop.type === 'integer') return prop.minimum ?? 1;
  if (prop.type === 'boolean') return true;
  if (prop.type === 'array') {
    const count = prop.minItems && prop.minItems > 0 ? prop.minItems : 0;
    return Array.from({ length: count }, () => (prop.items ? exampleValue(prop.items) : 'value'));
  }
  if (prop.type === 'object' && prop.properties) {
    const nested: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(prop.properties)) nested[key] = exampleValue(child);
    return nested;
  }
  return 'value';
}