let activeTab = 'playground';
let schemas = [];

const API_BASE = '/api';

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initSchemaRegistry();
  initPlayground();
  initLogsTab();

  loadPlaygroundSettings();
});

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function initNavigation() {
  const navButtons = document.querySelectorAll('.nav-btn');
  
  navButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      
      const targetTab = btn.getAttribute('data-tab');
      if (targetTab === activeTab) return;

      navButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(pane => {
        pane.classList.remove('active');
      });
      
      document.getElementById(targetTab).classList.add('active');
      activeTab = targetTab;

      if (activeTab === 'playground') {
        loadPlaygroundSettings();
      } else if (activeTab === 'schemas') {
        loadSchemas();
      } else if (activeTab === 'logs') {
        loadTelemetryData();
      }
    });
  });
}

function initSchemaRegistry() {
  const registerForm = document.getElementById('schema-registration-form');
  
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('new-schema-name').value.trim();
    const description = document.getElementById('new-schema-desc').value.trim();
    const jsonText = document.getElementById('raw-json-textarea').value.trim();
    
    let definition;
    try {
      definition = JSON.parse(jsonText);
    } catch (err) {
      showToast('Invalid JSON structure: ' + err.message, 'error');
      return;
    }
    
    try {
      const response = await fetch(`${API_BASE}/schemas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, definition })
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save schema.');
      
      showToast(data.message || 'Schema successfully registered!', 'success');

      registerForm.reset();

      loadSchemas();
      
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function loadSchemas() {
  try {
    const response = await fetch(`${API_BASE}/schemas`);
    if (!response.ok) throw new Error('Could not retrieve active schemas from server.');
    
    const list = await response.json();
    schemas = list;
    
    const container = document.getElementById('schemas-list-container');
    if (list.length === 0) {
      container.innerHTML = `<div class="empty-state">No schemas registered yet. Paste a JSON definition on the right to compile!</div>`;
      return;
    }
    
    container.innerHTML = list.map(s => `
      <div class="schema-item" data-id="${s.id}">
        <div class="schema-item-header">
          <h3>${escapeHtml(s.name)}</h3>
          <button type="button" class="btn-delete" data-id="${s.id}">Delete</button>
        </div>
        <p>${escapeHtml(s.description || 'No description.')}</p>
      </div>
    `).join('');

    container.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); 
        const schemaId = btn.getAttribute('data-id');
        if (confirm('Are you sure you want to delete this schema?')) {
          try {
            const delRes = await fetch(`${API_BASE}/schemas/${schemaId}`, { method: 'DELETE' });
            if (!delRes.ok) throw new Error('Delete request failed.');
            showToast('Schema deleted successfully.', 'success');
            loadSchemas();
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      });
    });

    container.querySelectorAll('.schema-item').forEach(card => {
      card.addEventListener('click', () => {
        container.querySelectorAll('.schema-item').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        
        const selectedId = card.getAttribute('data-id');
        const selectedObj = schemas.find(s => s.id === selectedId);
        
        if (selectedObj) {
          
          document.getElementById('raw-json-textarea').value = JSON.stringify(selectedObj.definition, null, 2);
          document.getElementById('new-schema-name').value = selectedObj.name;
          document.getElementById('new-schema-desc').value = selectedObj.description;
          showToast(`Loaded: ${selectedObj.name}`);
        }
      });
    });

  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initPlayground() {
  const providerSelect = document.getElementById('play-provider-select');
  const apiKeyContainer = document.getElementById('api-key-container');

  providerSelect.addEventListener('change', () => {
    const val = providerSelect.value;
    if (val === 'gemini' || val === 'openai') {
      apiKeyContainer.classList.remove('hidden');
    } else {
      apiKeyContainer.classList.add('hidden');
    }
  });

  document.getElementById('playground-call-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const schemaId = document.getElementById('play-schema-select').value;
    const provider = document.getElementById('play-provider-select').value;
    const strategy = document.getElementById('play-strategy-select').value;
    const model = provider === 'gemini' ? 'gemini-pro' : (provider === 'openai' ? 'gpt-4o-mini' : 'mock-model');
    const prompt = document.getElementById('play-prompt-input').value.trim();
    const rawVariables = document.getElementById('play-variables-input').value.trim();
    const apiKey = document.getElementById('play-apikey-input').value.trim();
    
    if (!schemaId) {
      showToast('Please create/select a validation schema first.', 'error');
      return;
    }
    
    let variables = {};
    if (rawVariables) {
      try {
        variables = JSON.parse(rawVariables);
      } catch (err) {
        showToast('Variables must be a valid JSON object.', 'error');
        return;
      }
    }

    const traceViewport = document.getElementById('trace-viewport-container');
    const traceStatus = document.getElementById('trace-status-badge');
    
    if (traceStatus) {
      traceStatus.className = 'badge badge-active';
      traceStatus.textContent = 'Executing...';
    }
    
    traceViewport.innerHTML = `<div class="empty-state">Dispatching call to server, waiting for enforcer state machine...</div>`;
    
    try {
      const response = await fetch(`${API_BASE}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaId, provider, strategy, model, prompt, variables, apiKey
        })
      });
      
      const payload = await response.json();
      
      if (response.status === 422) {
        
        if (traceStatus) {
          traceStatus.className = 'badge badge-inactive';
          traceStatus.textContent = 'Validation Crash';
        }
        renderTimelineTrace(payload.callId, false, payload);
        showToast('LLM response failed validation checks.', 'error');
      } 
      else if (!response.ok) {
        throw new Error(payload.error || 'Server error.');
      } 
      else {
        
        if (traceStatus) {
          traceStatus.className = 'badge badge-inactive';
          traceStatus.textContent = 'Complete';
        }
        renderTimelineTrace(payload.callId, true, payload);
        showToast('LLM response successfully validated!', 'success');
      }
      
    } catch (err) {
      if (traceStatus) {
        traceStatus.className = 'badge badge-inactive';
        traceStatus.textContent = 'Failed';
      }
      traceViewport.innerHTML = `<div class="error-callout">Error executing validation call: ${err.message}</div>`;
    }
  });
}

async function loadPlaygroundSettings() {
  try {
    const response = await fetch(`${API_BASE}/schemas`);
    const list = await response.json();
    
    const dropdown = document.getElementById('play-schema-select');
    if (list.length === 0) {
      dropdown.innerHTML = `<option value="">-- No Schemas Available --</option>`;
      return;
    }
    
    dropdown.innerHTML = list.map(s => `
      <option value="${s.id}">${escapeHtml(s.name)}</option>
    `).join('');

  } catch (err) {
    showToast('Failed to load schemas in selector dropdown.', 'error');
  }
}

async function renderTimelineTrace(callId, isSuccess, finalPayload) {
  const container = document.getElementById('trace-viewport-container');
  container.innerHTML = ''; 
  
  try {
    const response = await fetch(`${API_BASE}/calls/${callId}`);
    if (!response.ok) throw new Error('Could not fetch logs history.');
    
    const traceRecord = await response.json();
    const logs = traceRecord.logs || [];

    logs.forEach((log) => {
      const attemptDiv = document.createElement('div');
      
      if (log.error_message) {
        attemptDiv.className = 'trace-attempt error-border';
      } else {
        attemptDiv.className = 'trace-attempt success-border';
      }
      
      const headerClass = log.error_message ? 'fail' : 'ok';
      const outcomeText = log.error_message ? 'FAILED SCHEMA VALIDATION' : 'PASSED SCHEMA VALIDATION';
      
      attemptDiv.innerHTML = `
        <div class="attempt-header ${headerClass}">
          <span>ATTEMPT #${log.attempt_number}</span>
          <span>${outcomeText}</span>
        </div>
        
        <div class="trace-box">
          <strong>Raw LLM Output Stream:</strong>
          ${escapeHtml(log.response_received || '[No response]')}
        </div>
        
        ${log.error_message 
          ? `<div class="error-callout">Zod validation error: ${escapeHtml(log.error_message)}</div>`
          : ''
        }
      `;
      
      container.appendChild(attemptDiv);
    });

    const summaryDiv = document.createElement('div');
    if (isSuccess) {
      summaryDiv.innerHTML = `
        <div style="color: #68d391; font-weight: bold; margin-top: 15px; border-top: 1px dashed #2d3748; padding-top: 10px;">
          SUCCESS: VALID DATA CONFORMITY ACHIEVED
        </div>
        <div class="trace-box" style="color: #68d391; background: rgba(56, 161, 105, 0.15); border: 1px solid var(--success-color);">
          <strong>Clean Structured Output:</strong>
          ${JSON.stringify(finalPayload.final_output, null, 2)}
        </div>
        <div style="font-size: 11px; margin-top: 5px; color: #a0aec0;">
          Attempts: ${finalPayload.attempts} | Latency: ${finalPayload.total_latency} ms | Tokens: ${finalPayload.token_usage.total}
          ${finalPayload.partial_recovery_warning ? `<br/><span style="color: #d97706;">* ${finalPayload.partial_recovery_warning}</span>` : ''}
        </div>
      `;
    } else {
      summaryDiv.innerHTML = `
        <div style="color: #fc8181; font-weight: bold; margin-top: 15px; border-top: 1px dashed #2d3748; padding-top: 10px;">
          FATAL ERROR: RETRIES EXHAUSTED (LOUD GATEWAY CRASH)
        </div>
        <div class="error-callout">
          ${finalPayload.message || 'System failed to parse valid JSON matching constraints after 3 attempts.'}
        </div>
      `;
    }
    
    container.appendChild(summaryDiv);
    container.scrollTop = container.scrollHeight;

  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initLogsTab() {
  
}

async function loadTelemetryData() {
  try {
    
    const metricsRes = await fetch(`${API_BASE}/metrics`);
    if (!metricsRes.ok) throw new Error('Could not load statistics.');
    const metrics = await metricsRes.json();
    
    document.getElementById('stat-total-calls').textContent = metrics.total_calls || 0;
    document.getElementById('stat-success-rate').textContent = `${(metrics.success_rate || 0).toFixed(1)}%`;
    document.getElementById('stat-avg-latency').textContent = `${Math.round(metrics.avg_latency || 0)} ms`;

    const failuresRes = await fetch(`${API_BASE}/failures`);
    if (!failuresRes.ok) throw new Error('Could not load failures.');
    const failures = await failuresRes.json();
    
    const body = document.getElementById('failures-analytics-body');
    if (failures.length === 0) {
      body.innerHTML = `<tr><td colspan="4" class="empty-state">No failed prompt runs logged. System operating cleanly!</td></tr>`;
      return;
    }
    
    body.innerHTML = failures.map(f => `
      <tr>
        <td><strong>${escapeHtml(f.schema_name)}</strong></td>
        <td><code>${escapeHtml(f.prompt)}</code></td>
        <td class="text-center">${f.failure_count}</td>
        <td><span style="color:var(--error-color); font-family:monospace;">${escapeHtml(f.most_common_error)}</span></td>
      </tr>
    `).join('');

  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escapeHtml(string) {
  if (!string) return '';
  return string
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
