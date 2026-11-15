/** A deliberately small JSON-Schema subset: enough to reject bad arguments before a tool runs. */

export interface SchemaProp {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: SchemaProp;
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
    const current = object[key];
    if (current === undefined) continue;
    if (prop.type) {
      const actual = typeOf(current);
      const matches = prop.type === 'integer' ? actual === 'number' && Number.isInteger(current) : actual === prop.type;
      if (!matches) {
        issues.push({ path: key, expected: prop.type, actual });
        continue;
      }
    }
    if (prop.enum && !prop.enum.includes(String(current))) {
      issues.push({ path: key, expected: `one of ${prop.enum.join(' | ')}`, actual: String(current) });
    }
    if (typeof current === 'number') {
      if (prop.minimum !== undefined && current < prop.minimum) {
        issues.push({ path: key, expected: `>= ${prop.minimum}`, actual: String(current) });
      }
      if (prop.maximum !== undefined && current > prop.maximum) {
        issues.push({ path: key, expected: `<= ${prop.maximum}`, actual: String(current) });
      }
    }
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

export function positiveExample(schema: ToolSchema): string {
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) example[key] = prop.default;
    else if (prop.enum && prop.enum.length > 0) example[key] = prop.enum[0];
    else if (prop.type === 'string') example[key] = prop.description?.match(/e\.g\. ([^,)]+)/)?.[1] ?? 'value';
    else if (prop.type === 'number' || prop.type === 'integer') example[key] = prop.minimum ?? 1;
    else if (prop.type === 'boolean') example[key] = true;
    else if (prop.type === 'array') example[key] = [];
  }
  return JSON.stringify(example);
}
