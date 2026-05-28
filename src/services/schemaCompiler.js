const { z } = require('zod');

function compileSchema(def) {
  if (!def || typeof def !== 'object') {
    throw new Error('Schema definition must be a non-null object');
  }

  if (def.type === 'object' && def.properties) {
    const shape = {};
    for (const [key, prop] of Object.entries(def.properties)) {
      shape[key] = compileProperty(prop, key);
    }
    return z.object(shape);
  }

  return compileProperty(def, 'root');
}

function compileProperty(prop, name = 'property') {
  if (!prop || typeof prop !== 'object') {
    throw new Error(`Property '${name}' must be a configuration object`);
  }

  let zodNode;

  switch (prop.type) {
    case 'string':
      zodNode = z.string();
      if (prop.constraints) {
        const c = prop.constraints;
        if (c.min !== undefined && c.min !== null) {
          zodNode = zodNode.min(Number(c.min), { message: `'${name}' must be at least ${c.min} characters` });
        }
        if (c.max !== undefined && c.max !== null) {
          zodNode = zodNode.max(Number(c.max), { message: `'${name}' cannot exceed ${c.max} characters` });
        }
        if (c.format === 'email') {
          zodNode = zodNode.email({ message: `'${name}' must be a valid email address` });
        }
        if (c.format === 'url') {
          zodNode = zodNode.url({ message: `'${name}' must be a valid URL` });
        }
        if (c.format === 'uuid') {
          zodNode = zodNode.uuid({ message: `'${name}' must be a valid UUID` });
        }
        if (c.regex) {
          try {
            const pattern = new RegExp(c.regex);
            zodNode = zodNode.regex(pattern, { message: `'${name}' must match format pattern: ${c.regex}` });
          } catch (e) {
            throw new Error(`Invalid regex pattern on field '${name}': ${c.regex}`);
          }
        }
      }
      break;

    case 'number':
      zodNode = z.number({ invalid_type_error: `'${name}' must be a number` });
      if (prop.constraints) {
        const c = prop.constraints;
        if (c.min !== undefined && c.min !== null) {
          zodNode = zodNode.min(Number(c.min), { message: `'${name}' must be at least ${c.min}` });
        }
        if (c.max !== undefined && c.max !== null) {
          zodNode = zodNode.max(Number(c.max), { message: `'${name}' cannot exceed ${c.max}` });
        }
      }
      break;

    case 'enum':
      if (!Array.isArray(prop.values) || prop.values.length === 0) {
        throw new Error(`Enum property '${name}' requires a non-empty array of 'values'`);
      }
      zodNode = z.enum(prop.values, {
        errorMap: () => ({ message: `'${name}' must be one of: ${prop.values.join(', ')}` })
      });
      break;

    case 'array':
      if (!prop.items || typeof prop.items !== 'object') {
        throw new Error(`Array property '${name}' requires an 'items' object definition`);
      }
      zodNode = z.array(compileProperty(prop.items, `${name}[]`));
      break;

    case 'object':
      if (!prop.properties || typeof prop.properties !== 'object') {
        throw new Error(`Nested object property '${name}' requires a 'properties' map`);
      }
      const subShape = {};
      for (const [subKey, subProp] of Object.entries(prop.properties)) {
        subShape[subKey] = compileProperty(subProp, `${name}.${subKey}`);
      }
      zodNode = z.object(subShape);
      break;

    default:
      throw new Error(`Unsupported schema field type: '${prop.type}' on field '${name}'`);
  }

  if (prop.optional === true) {
    zodNode = zodNode.optional().nullable();
  }

  return zodNode;
}

function generateFewShotExample(def) {
  if (def.type === 'object' && def.properties) {
    const example = {};
    for (const [key, prop] of Object.entries(def.properties)) {
      example[key] = generatePropertyExample(prop);
    }
    return example;
  }
  return generatePropertyExample(def);
}

function generatePropertyExample(prop) {
  if (prop.optional && Math.random() > 0.8) {
    return null; 
  }

  switch (prop.type) {
    case 'string':
      const c = prop.constraints || {};
      if (c.format === 'email') return 'sarah.connor@typecast.ai';
      if (c.format === 'url') return 'https://typecast.ai';
      if (c.format === 'uuid') return 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
      
      let base = 'Tech Corp';
      if (c.min && base.length < c.min) {
        base = base.padEnd(c.min, ' Enterprise');
      }
      if (c.max && base.length > c.max) {
        base = base.substring(0, c.max);
      }
      return base;

    case 'number':
      const nc = prop.constraints || {};
      const min = nc.min !== undefined ? Number(nc.min) : 0;
      const max = nc.max !== undefined ? Number(nc.max) : 100;
      
      if (nc.min !== undefined && nc.max !== undefined) {
        return Math.floor((min + max) / 2);
      }
      if (nc.min !== undefined) return min + 10;
      if (nc.max !== undefined) return max - 10;
      return 42;

    case 'enum':
      return prop.values[0];

    case 'array':
      return [
        generatePropertyExample(prop.items),
        generatePropertyExample(prop.items)
      ];

    case 'object':
      const obj = {};
      for (const [k, p] of Object.entries(prop.properties || {})) {
        obj[k] = generatePropertyExample(p);
      }
      return obj;

    default:
      return null;
  }
}

function translateToJsonSchema(def) {
  if (def.type === 'object' && def.properties) {
    const required = [];
    const properties = {};

    for (const [key, prop] of Object.entries(def.properties)) {
      properties[key] = translatePropertyToJsonSchema(prop, required, key);
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false
    };
  }
  return translatePropertyToJsonSchema(def);
}

function translatePropertyToJsonSchema(prop, requiredArray = [], name = '') {
  let schema = {};

  if (!prop.optional && requiredArray && name) {
    requiredArray.push(name);
  }

  switch (prop.type) {
    case 'string':
      schema.type = 'string';
      if (prop.constraints) {
        const c = prop.constraints;
        if (c.min !== undefined) schema.minLength = Number(c.min);
        if (c.max !== undefined) schema.maxLength = Number(c.max);
        if (c.format) schema.format = c.format;
        if (c.regex) schema.pattern = c.regex;
      }
      break;

    case 'number':
      schema.type = 'number';
      if (prop.constraints) {
        const c = prop.constraints;
        if (c.min !== undefined) schema.minimum = Number(c.min);
        if (c.max !== undefined) schema.maximum = Number(c.max);
      }
      break;

    case 'enum':
      schema.type = 'string';
      schema.enum = prop.values;
      break;

    case 'array':
      schema.type = 'array';
      schema.items = translatePropertyToJsonSchema(prop.items);
      break;

    case 'object':
      schema.type = 'object';
      const subReq = [];
      const subProps = {};
      for (const [k, p] of Object.entries(prop.properties || {})) {
        subProps[k] = translatePropertyToJsonSchema(p, subReq, k);
      }
      schema.properties = subProps;
      if (subReq.length > 0) schema.required = subReq;
      schema.additionalProperties = false;
      break;
  }

  return schema;
}

module.exports = {
  compileSchema,
  generateFewShotExample,
  translateToJsonSchema
};
