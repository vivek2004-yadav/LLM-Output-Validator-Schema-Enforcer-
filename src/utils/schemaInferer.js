function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch (_) {
    return false;
  }
}

function isValidUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function inferSchema(examples) {
  if (!Array.isArray(examples) || examples.length === 0) {
    throw new Error('Inference requires a non-empty array of examples');
  }

  const objects = examples.filter(ex => ex && typeof ex === 'object' && !Array.isArray(ex));
  if (objects.length === 0) {
    throw new Error('All provided examples must be valid JSON objects');
  }

  const allKeys = new Set();
  objects.forEach(obj => {
    Object.keys(obj).forEach(key => allKeys.add(key));
  });

  const properties = {};

  for (const key of allKeys) {
    const values = objects
      .map(obj => obj[key])
      .filter(val => val !== undefined && val !== null);

    if (values.length === 0) {
      properties[key] = {
        type: 'string',
        optional: true,
        description: `Inferred optional field '${key}' (no sample data was available)`
      };
      continue;
    }

    const isOptional = objects.some(obj => obj[key] === undefined || obj[key] === null);

    const inferredProp = inferPropertyType(values, key);
    
    if (isOptional) {
      inferredProp.optional = true;
    }

    properties[key] = inferredProp;
  }

  return {
    type: 'object',
    properties
  };
}

function inferPropertyType(values, keyName) {
  const valueTypes = values.map(v => {
    if (Array.isArray(v)) return 'array';
    if (v && typeof v === 'object') return 'object';
    return typeof v;
  });

  const uniqueTypes = [...new Set(valueTypes)];
  const primaryType = uniqueTypes.length === 1 ? uniqueTypes[0] : 'string';

  switch (primaryType) {
    case 'number':
      
      const numbers = values.map(Number);
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      return {
        type: 'number',
        constraints: { min, max }
      };

    case 'boolean':
      
      return {
        type: 'enum',
        values: ['true', 'false']
      };

    case 'array':
      
      const flatItems = [];
      values.forEach(arr => {
        if (Array.isArray(arr)) flatItems.push(...arr);
      });
      
      const itemSchema = flatItems.length > 0 
        ? inferPropertyType(flatItems, `${keyName}[]`) 
        : { type: 'string' };

      return {
        type: 'array',
        items: itemSchema
      };

    case 'object':
      
      const subObjects = values.filter(v => v && typeof v === 'object' && !Array.isArray(v));
      if (subObjects.length === 0) {
        return { type: 'object', properties: {} };
      }
      return inferSchema(subObjects);

    case 'string':
    default:
      
      const allEmails = values.every(v => typeof v === 'string' && isValidEmail(v));
      const allUrls = values.every(v => typeof v === 'string' && isValidUrl(v));
      const allUuids = values.every(v => typeof v === 'string' && isValidUuid(v));

      if (allEmails) {
        return { type: 'string', constraints: { format: 'email' } };
      }
      if (allUrls) {
        return { type: 'string', constraints: { format: 'url' } };
      }
      if (allUuids) {
        return { type: 'string', constraints: { format: 'uuid' } };
      }

      const uniqueValues = [...new Set(values.map(String))];
      if (uniqueValues.length <= 4 && values.length >= 3) {
        return {
          type: 'enum',
          values: uniqueValues
        };
      }

      const lengths = values.map(v => String(v).length);
      const minLength = Math.min(...lengths);
      const maxLength = Math.max(...lengths);
      
      return {
        type: 'string',
        constraints: {
          min: minLength > 0 ? Math.max(0, minLength - 2) : 0,
          max: Math.max(maxLength + 10, 50)
        }
      };
  }
}

module.exports = {
  inferSchema
};
