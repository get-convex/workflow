import {
  type GenericValidator,
  type PropertyValidators,
  v,
  type Value,
} from "convex/values";

export function checkArgs(
  args: Value,
  validator: PropertyValidators | undefined,
) {
  if (!validator) {
    return;
  }
  const result = check(args, v.object(validator));
  if (!result.ok) {
    throw new Error(result.message);
  }
}

function check(
  value: Value,
  validator: GenericValidator,
): { ok: true } | { ok: false; message: string } {
  switch (validator.kind) {
    case "id": {
      if (typeof value !== "string") {
        return {
          ok: false,
          message: `v.id() failed: Expected an ID, received: ${value}`,
        };
      }
      break;
    }
    case "string": {
      if (typeof value !== "string") {
        return {
          ok: false,
          message: `v.string() failed: Expected a string, received: ${value}`,
        };
      }
      break;
    }
    case "float64": {
      if (typeof value !== "number") {
        return {
          ok: false,
          message: `v.float64() failed: Expected a number, received: ${value}`,
        };
      }
      break;
    }
    case "int64": {
      if (typeof value !== "bigint") {
        return {
          ok: false,
          message: `v.int64() failed: Expected a number, received: ${value}`,
        };
      }
      break;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return {
          ok: false,
          message: `v.boolean() failed: Expected a boolean, received: ${value}`,
        };
      }
      break;
    }
    case "null": {
      if (value !== null) {
        return {
          ok: false,
          message: `v.null() failed: Expected null, received: ${value}`,
        };
      }
      break;
    }
    case "any": {
      break;
    }
    case "literal": {
      if (value !== validator.value) {
        return {
          ok: false,
          message: `v.literal(${validator.value}) failed: Expected ${validator.value}, received: ${value}`,
        };
      }
      break;
    }
    case "bytes": {
      if (!(value instanceof ArrayBuffer)) {
        return {
          ok: false,
          message: `v.bytes() failed: Expected an ArrayBuffer, received: ${value}`,
        };
      }
      break;
    }
    case "object": {
      if (!isSimpleObject(value)) {
        return {
          ok: false,
          message: `v.object() failed: Expected a simple object, received: ${value}`,
        };
      }
      for (const [key, fieldValidator] of Object.entries(validator.fields)) {
        const fieldValue = (value as Record<string, Value>)[key];
        if (fieldValue === undefined) {
          if (fieldValidator.isOptional === "required") {
            return {
              ok: false,
              message: `v.object() failed: Expected field "${key}", received: ${value}`,
            };
          }
        } else {
          const result = check(fieldValue, fieldValidator);
          if (!result.ok) {
            return {
              ok: false,
              message: `v.object() failed: ${result.message}`,
            };
          }
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return {
          ok: false,
          message: `v.array() failed: Expected an array, received: ${value}`,
        };
      }
      for (const element of value) {
        const result = check(element, validator.element);
        if (!result.ok) {
          return { ok: false, message: `v.array() failed: ${result.message}` };
        }
      }
      break;
    }
    case "record": {
      if (!isSimpleObject(value)) {
        return {
          ok: false,
          message: `v.record() failed: Expected a simple object, received: ${value}`,
        };
      }
      for (const [field, fieldValue] of Object.entries(
        value as Record<string, Value>,
      )) {
        const keyResult = check(field, validator.key);
        if (!keyResult.ok) {
          return {
            ok: false,
            message: `v.record() failed: ${keyResult.message}`,
          };
        }
        const valueResult = check(fieldValue, validator.value);
        if (!valueResult.ok) {
          return {
            ok: false,
            message: `v.record() failed: ${valueResult.message}`,
          };
        }
      }
      break;
    }
    case "union": {
      let anyOk = false;
      for (const member of validator.members) {
        const result = check(value, member);
        if (result.ok) {
          anyOk = true;
          break;
        }
      }
      if (!anyOk) {
        return {
          ok: false,
          message: `v.union() failed: Expected one of: ${validator.members.map((m) => m.kind).join(", ")}, received: ${value}`,
        };
      }
      break;
    }
    default: {
      throw new Error(`Unknown validator kind`);
    }
  }
  return { ok: true };
}

function isSimpleObject(value: unknown) {
  const isObject = typeof value === "object";
  const prototype = Object.getPrototypeOf(value);
  const isSimple =
    prototype === null ||
    prototype === Object.prototype ||
    // Objects generated from other contexts (e.g. across Node.js `vm` modules) will not satisfy the previous
    // conditions but are still simple objects.
    prototype?.constructor?.name === "Object";
  return isObject && isSimple;
}
