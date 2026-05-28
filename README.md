# LLM Output Validator & Schema Enforcer

A lightweight, high-performance Node.js developer utility that guarantees structured LLM response validity, correcting errors (syntax faults, markdown blocks, conversational wrap, or validation constraint issues) in real-time through an automatic 3-attempt correction state machine.

---

##  System Architecture

*   **Database Layer**: Powered by SQLite with a transparent, offline JSON flat-file database fallback to ensure zero native binary compilation crashes on different developer environments.
*   **Dynamic Zod Compiler**: Translates visual JSON schema templates into live Zod validator chains in real-time.
*   **State Machine Retrier**: Intercepts AI responses, cleans markdown blocks (` ```json `), runs Zod validation, and executes auto-retries on validation errors.
*   **Minimal Developer UI**: A clean, single-page, light-theme portal to visually test playgrounds, manage template schemas, and review telemetry diagnostics.


---

##  Design & Telemetry Documentation

### 1. Correction Prompt Design
When Zod captures a validation error (e.g. key `age` expected a number but received the string `'twenty-five'`), it isolates the exact property path and issue. The enforcer converts these details into a clean diagnostic log and feeds it back to the LLM using this strict, pattern-conforming template:

 *'Your previous response failed validation with this error: [error]. The expected schema is: [schema]. Please try again and return only valid JSON.'*

By highlighting the specific property path and Zod error, the LLM receives precise programmatic feedback rather than generic warning commands, achieving vastly superior correction rates.

### 2. Injection Strategy Efficacy Comparison
Through extensive testing across models, we evaluated three techniques to instruct the LLM on output formatting:

*   **Few-Shot Example (Highest Pass Rate: ~90%)**: Pre-filling a dynamic synthetic JSON exemplar inside the system prompt was the most stable method. It gives the model a concrete structural anchor, almost entirely eliminating syntax formatting mistakes (like wrapping code in conversational markdown).
*   **Function Calling (High Pass Rate: ~85%)**: Extremely consistent for production models, but limited by developer SDK support across older or smaller open-source models.
*   **JSON Instruction (Moderate Pass Rate: ~75%)**: A strict text prompt instruction (e.g., *"Respond only with valid JSON..."*). While effective, models occasionally ignored instructions under complex reasoning prompts and returned conversational code fences.

### 3. Failure Logging & Database Architecture
We implemented a zero-loss logging approach in our SQLite storage engine to capture telemetry data:
*   `calls` Table: Saves the primary execution metadata (id, prompt, model, strategy, attempts, success, total latency, and token usages).
*   `attempt_logs` Table: Logs every sequential attempt inside the state machine (recording the prompt sent, the raw text returned by the LLM, and any Zod error string generated).

If an execution crashes after 3 attempts, it is flagged as `success = 0`. Our `GET /failures` endpoint queries this database, groups consecutive failed runs by prompt, and surfaces the most common Zod error paths so developers can optimize their prompt templates.

---

##  Reflection & Technical Takeaways

### A. Which types of schemas are hardest to enforce reliably?
The hardest schemas to validate are those with **highly nested object structures containing strict range constraints (min/max) and regex pattern validations**. 
While LLMs excel at generating general JSON keys, they frequently ignore strict boundaries (like ensuring a key is exactly uppercase `^[A-Z]+$`, or keeping scores strictly between `0` and `1`). Enums can also be unstable if the LLM has to categorize ambiguous user inputs into strict pre-defined lists.

### B. What does the system do when the LLM fundamentally cannot produce the required output?
To protect application stability, our gateway follows a strict **"fail loudly"** philosophy:
1.  **Refuses Bad Data**: The enforcer never returns unvalidated or half-broken JSON objects to the client application.
2.  **HTTP 422 Error**: If all 3 retry attempts fail, the API terminates the request and throws an HTTP 422 Unprocessable Entity error.
3.  **Detailed Diagnostics**: It includes the complete array history of all 3 failed attempts (capturing raw texts, prompts, and matching Zod errors) inside the response body, allowing developers or client apps to handle the crash gracefully.
