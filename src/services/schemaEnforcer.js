const { compileSchema, generateFewShotExample, translateToJsonSchema } = require('./schemaCompiler');
const { callLLM } = require('./llmService');
const { v4: uuidv4 } = require('uuid');

function cleanLLMOutput(text) {
  if (!text) return '';
  let cleaned = text.trim();

  const markdownRegex = /```(?:json)?([\s\S]*?)```/i;
  const match = cleaned.match(markdownRegex);
  if (match) {
    cleaned = match[1].trim();
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return cleaned;
}

function resolveVariables(prompt, variables = {}) {
  let resolved = prompt;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    resolved = resolved.replace(regex, value);
  }
  return resolved;
}

function formatZodErrors(zodError) {
  return zodError.issues.map(issue => {
    const fieldPath = issue.path.join('.');
    return `Field '${fieldPath}': ${issue.message}`;
  }).join('; ');
}

function isPathOptional(definition, path) {
  if (!definition || !Array.isArray(path) || path.length === 0) return false;
  
  let current = definition;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];

    if (current.type === 'object' && current.properties && current.properties[key]) {
      if (i === path.length - 1) {
        return !!current.properties[key].optional;
      }
      current = current.properties[key];
    } 
    
    else if (current.type === 'array' && current.items) {
      current = current.items;

      if (typeof key === 'number' && i === path.length - 1) {
        return !!current.optional;
      }
    } 
    else {
      return false;
    }
  }
  return false;
}

function attemptPartialRecovery(parsedObj, zodError, definition) {
  const issues = zodError.issues;

  const allOptional = issues.every(issue => isPathOptional(definition, issue.path));
  
  if (!allOptional || issues.length === 0) {
    return { success: false };
  }

  const recoveredObj = JSON.parse(JSON.stringify(parsedObj));
  const omittedFields = [];

  for (const issue of issues) {
    const path = issue.path;

    let current = recoveredObj;
    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      if (i === path.length - 1) {
        delete current[key];
        omittedFields.push(path.join('.'));
      } else {
        current = current[key];
      }
    }
  }

  return {
    success: true,
    recoveredObject: recoveredObj,
    omittedFields
  };
}

async function executeValidatedCall({
  schema,       
  prompt,       
  variables,    
  strategy,     
  model,        
  provider,     
  db,           
  apiKey = null 
}) {
  const callId = uuidv4();
  const startTotalTime = Date.now();

  const definition = JSON.parse(schema.definition);

  let zodSchema;
  try {
    zodSchema = compileSchema(definition);
  } catch (err) {
    throw new Error(`Schema compilation failed: ${err.message}`);
  }

  const resolvedPrompt = resolveVariables(prompt, variables);

  const jsonSchemaRepresent = translateToJsonSchema(definition);
  const schemaString = JSON.stringify(jsonSchemaRepresent, null, 2);

  let systemPrompt = 'You are a precise data extraction engine. You extract structured information and respond strictly in valid JSON.\n';

  if (strategy === 'few_shot') {
    const fewShotExample = generateFewShotExample(definition);
    systemPrompt += `\nINSTRUCTIONS:
1. Analyze the user request.
2. Output a single, perfectly structured JSON object matching this schema definition:
${schemaString}
3. Study this example of a valid response structure:
${JSON.stringify(fewShotExample, null, 2)}
4. Return ONLY valid JSON. Do not include markdown code block formatting (e.g. \`\`\`json), conversational prefixes, or explanations.`;
  } 
  else if (strategy === 'function_calling') {
    systemPrompt += `\nINSTRUCTIONS:
You are acting as an API function handler. Construct the arguments representing the execution result.
Your output must be a single valid JSON object representing the parameters matching this schema definition:
${schemaString}
Do not wrap your output in markdown code blocks. Return only valid JSON.`;
  } 
  else {
    
    systemPrompt += `\nINSTRUCTIONS:
1. Respond only with valid JSON matching this schema definition:
${schemaString}
2. Strictly enforce all types and property names specified in the schema.
3. Do NOT wrap your output in markdown \`\`\`json blocks.
4. Do NOT write any chatty text before or after the JSON. Return only the raw parseable JSON object.`;
  }

  let currentAttempt = 1;
  const maxAttempts = 3;
  let success = false;
  let finalParsedOutput = null;
  let activePrompt = resolvedPrompt;
  let accumulatedPromptTokens = 0;
  let accumulatedCompletionTokens = 0;
  let partialRecoveryWarning = null;
  const attemptsLogs = [];

  while (currentAttempt <= maxAttempts) {
    console.log(`[Schema Enforcer] Executing call ${callId}, Attempt ${currentAttempt}/${maxAttempts}`);
    
    let rawText = '';
    let tokens = { prompt: 0, completion: 0, total: 0 };
    let latencyMs = 0;
    let currentError = null;

    try {
      const response = await callLLM({
        provider,
        model,
        systemPrompt,
        userPrompt: activePrompt,
        originalPrompt: resolvedPrompt,
        schemaDef: definition,
        attemptCount: currentAttempt,
        apiKey
      });

      rawText = response.text;
      tokens = response.tokens;
      latencyMs = response.latencyMs;

      accumulatedPromptTokens += tokens.prompt;
      accumulatedCompletionTokens += tokens.completion;

      const cleaned = cleanLLMOutput(rawText);
      let parsedObj;

      try {
        parsedObj = JSON.parse(cleaned);
      } catch (jsonErr) {
        throw new Error(`JSON Parsing Error: Invalid JSON syntax. ${jsonErr.message}`);
      }

      const validationResult = zodSchema.safeParse(parsedObj);

      if (validationResult.success) {
        success = true;
        finalParsedOutput = validationResult.data;

        attemptsLogs.push({
          attempt_number: currentAttempt,
          prompt_used: activePrompt,
          response_received: rawText,
          error_message: null
        });
        
        break; 
      } 
      else {
        
        const recovery = attemptPartialRecovery(parsedObj, validationResult.error, definition);
        
        if (recovery.success) {
          success = true;
          finalParsedOutput = recovery.recoveredObject;
          partialRecoveryWarning = `Recovered by omitting invalid optional fields: [${recovery.omittedFields.join(', ')}]`;

          attemptsLogs.push({
            attempt_number: currentAttempt,
            prompt_used: activePrompt,
            response_received: rawText,
            error_message: `Partial recovery: omitted invalid optional fields [${recovery.omittedFields.join(', ')}]`
          });
          
          break; 
        }

        const formattedErr = formatZodErrors(validationResult.error);
        throw new Error(`Schema Constraint Violations: ${formattedErr}`);
      }

    } catch (attemptErr) {
      currentError = attemptErr.message;
      console.warn(`[Schema Enforcer] Attempt ${currentAttempt} failed:`, currentError);

      attemptsLogs.push({
        attempt_number: currentAttempt,
        prompt_used: activePrompt,
        response_received: rawText || '[Connection / Dispatch Timeout]',
        error_message: currentError
      });

      if (currentAttempt < maxAttempts) {
        
        activePrompt = `Your previous response failed validation with this error: ${currentError}. The expected schema is: ${schemaString}. Please try again and return only valid JSON.`;
      }
    }

    currentAttempt++;
  }

  const totalLatency = Date.now() - startTotalTime;
  const finalTokens = {
    prompt: accumulatedPromptTokens,
    completion: accumulatedCompletionTokens,
    total: accumulatedPromptTokens + accumulatedCompletionTokens
  };

  const finalCallData = {
    id: callId,
    schema_id: schema.id,
    prompt: resolvedPrompt,
    strategy,
    model,
    attempts: Math.min(currentAttempt, maxAttempts),
    success,
    final_output: success ? finalParsedOutput : null,
    latency_ms: totalLatency,
    token_usage: finalTokens
  };

  await db.calls.insert(finalCallData);

  for (const log of attemptsLogs) {
    await db.attemptLogs.insert({
      call_id: callId,
      attempt_number: log.attempt_number,
      prompt_used: log.prompt_used,
      response_received: log.response_received,
      error_message: log.error_message
    });
  }

  if (!success) {
    const errorPayload = {
      message: `LLM Call failed validation after ${maxAttempts} attempts.`,
      callId,
      attemptsCount: maxAttempts,
      schema_name: schema.name,
      failures: attemptsLogs.map(l => ({
        attempt: l.attempt_number,
        response: l.response_received,
        error: l.error_message
      }))
    };
    
    const loudError = new Error(JSON.stringify(errorPayload));
    loudError.isValidationError = true;
    loudError.payload = errorPayload;
    throw loudError;
  }

  return {
    callId,
    success: true,
    final_output: finalParsedOutput,
    attempts: Math.min(currentAttempt, maxAttempts),
    correction_needed: Math.min(currentAttempt, maxAttempts) > 1,
    total_latency: totalLatency,
    token_usage: finalTokens,
    partial_recovery_warning: partialRecoveryWarning
  };
}

module.exports = {
  executeValidatedCall
};
