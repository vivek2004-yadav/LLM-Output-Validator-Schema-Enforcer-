const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateFewShotExample } = require('./schemaCompiler');

async function callOpenAI(model, systemPrompt, userPrompt, apiKey) {
  if (!apiKey) {
    throw new Error('OpenAI API Key is missing. Please set OPENAI_API_KEY in your env or playground.');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorDetails}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content;
  const promptTokens = data.usage?.prompt_tokens || 0;
  const completionTokens = data.usage?.completion_tokens || 0;

  return {
    text,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens
    }
  };
}

async function callGemini(model, systemPrompt, userPrompt, apiKey) {
  const finalKey = apiKey || process.env.GEMINI_API_KEY;
  if (!finalKey) {
    throw new Error('Gemini API Key is missing. Please set GEMINI_API_KEY in your env or frontend.');
  }

  const genAI = new GoogleGenerativeAI(finalKey);
  const targetModel = model || 'gemini-1.5-flash';
  const isLegacyModel = targetModel.toLowerCase().includes('pro') && !targetModel.toLowerCase().includes('1.5');
  
  const modelInstance = genAI.getGenerativeModel({
    model: targetModel,
    generationConfig: {
      temperature: 0.2
    }
  });

  let contentsPayload;
  if (isLegacyModel) {
    const unifiedPrompt = `${systemPrompt}\n\nUser Request:\n${userPrompt}`;
    contentsPayload = {
      contents: [{ role: 'user', parts: [{ text: unifiedPrompt }] }]
    };
  } else {
    contentsPayload = {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction: systemPrompt
    };
  }

  const result = await modelInstance.generateContent(contentsPayload);

  const text = result.response.text();

  let promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  let completionTokens = Math.ceil(text.length / 4);

  try {
    const tokenCount = await modelInstance.countTokens(userPrompt);
    promptTokens = tokenCount.totalTokens || promptTokens;
  } catch (e) {
    
  }

  return {
    text,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens
    }
  };
}

async function callMockEngine(schemaDef, systemPrompt, userPrompt, attemptCount, originalPrompt = null) {
  
  await new Promise(resolve => setTimeout(resolve, 800));

  const cleanExample = generateFewShotExample(schemaDef);
  const promptToSearch = originalPrompt || userPrompt;
  const hasHardFailKeyword = promptToSearch.toLowerCase().includes('hard-fail') || systemPrompt.toLowerCase().includes('hard-fail');
  const isCorrectionAttempt = userPrompt.includes('Your previous response failed validation');

  let textResponse = '';

  if (hasHardFailKeyword) {
    textResponse = `{"error": "This is a forced mock hard failure simulation.", "prompt": "${userPrompt.substring(0, 30)}..."}`;
  }
  else if (!isCorrectionAttempt && attemptCount === 1) {
    
    const errorType = Math.floor(Math.random() * 3);

    if (errorType === 0) {
      
      textResponse = `Sure! I have extracted that data for you. Here is the structured JSON output:

\`\`\`json
${JSON.stringify(cleanExample, null, 2)}
\`\`\`

Let me know if you need anything else!`;
    } 
    else if (errorType === 1) {
      
      const corrupted = { ...cleanExample };

      let corruptedField = '';
      if (schemaDef.properties) {
        for (const [key, val] of Object.entries(schemaDef.properties)) {
          if (val.type === 'number') {
            const min = val.constraints?.min !== undefined ? Number(val.constraints.min) : 0;
            const max = val.constraints?.max !== undefined ? Number(val.constraints.max) : 100;
            corrupted[key] = max + 500; 
            corruptedField = key;
            break;
          } else if (val.type === 'string' && val.constraints?.format === 'email') {
            corrupted[key] = 'not-a-valid-email-domain'; 
            corruptedField = key;
            break;
          }
        }
      }

      if (!corruptedField) {
        corrupted['extraUnsupportedField'] = 'this should not exist';
      }

      textResponse = JSON.stringify(corrupted, null, 2);
    } 
    else {
      
      const rawJson = JSON.stringify(cleanExample, null, 2);
      textResponse = rawJson.substring(0, rawJson.length - 8); 
    }
  } 
  
  else {
    textResponse = JSON.stringify(cleanExample, null, 2);
  }

  const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  const completionTokens = Math.ceil(textResponse.length / 4);

  return {
    text: textResponse,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens
    }
  };
}

async function callLLM({ provider, model, systemPrompt, userPrompt, originalPrompt, schemaDef, attemptCount = 1, apiKey = null }) {
  console.log(`[LLM Call] Dispatching to ${provider} (${model || 'default'}). Attempt: ${attemptCount}`);
  
  const start = Date.now();
  let result;

  try {
    if (provider === 'gemini') {
      result = await callGemini(model, systemPrompt, userPrompt, apiKey);
    } else if (provider === 'openai') {
      result = await callOpenAI(model, systemPrompt, userPrompt, apiKey);
    } else {
      
      result = await callMockEngine(schemaDef, systemPrompt, userPrompt, attemptCount, originalPrompt);
    }

    const latency = Date.now() - start;

    return {
      ...result,
      latencyMs: latency
    };
  } catch (err) {
    console.error(`[LLM Call Error] Provider ${provider} failed:`, err.message);
    throw err;
  }
}

module.exports = {
  callLLM
};
