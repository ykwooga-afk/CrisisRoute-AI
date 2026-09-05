# Privacy Notice

CrisisRoute AI is a hackathon demo, not a production emergency, medical, or identity service.

## Data Processing

- In **Live mode**, user-supplied report text and the fixed five-case evidence prompt are sent through Gonka Router for processing by the configured DeepSeek Analyst and MiniMax Blind Reviewer.
- In **Replay mode**, the browser loads a sanitized deterministic record and sends no current model request.
- In **Demo mode**, synthetic local data is used and no model inference is requested.
- Human Decision, Audit, Brief, and Proof records exist only in server memory. They disappear when the process restarts.
- The current release has no persistent database and no formal user account system.

Do not submit real medical records, identity numbers, telephone numbers, precise private addresses, credentials, or other sensitive personal information. Use synthetic or appropriately minimized demonstration text.

## Integrity and Logging

Proof Capsule verifies local payload integrity only. It does not prove that a report is true, that an identity is genuine, or that a real-world action occurred. Application logs should never record API keys, Authorization headers, raw prompts, raw model content, or hidden reasoning.

For real emergencies, contact the appropriate official emergency service directly.
