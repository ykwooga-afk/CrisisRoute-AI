const {
  GonkaClientError,
  createGonkaClientFromEnv,
  DEFAULT_MODELS
} = require("../backend/gonkaClient");

const smokeCases = [
  {
    label: "Analyst",
    model: DEFAULT_MODELS.analyst,
    expected: { status: "ready", role: "analyst" }
  },
  {
    label: "Reviewer",
    model: DEFAULT_MODELS.reviewer,
    expected: { status: "ready", role: "reviewer" }
  }
];

function usageSummary(usage) {
  if (!usage) return "Not Provided";
  return `Prompt=${usage.promptTokens} Completion=${usage.completionTokens} Total=${usage.totalTokens}`;
}

function semanticMatch(actual, expected) {
  return actual?.status === expected.status && actual?.role === expected.role;
}

async function run() {
  let client;
  try {
    client = createGonkaClientFromEnv();
  } catch (error) {
    const code = error instanceof GonkaClientError ? error.code : "UNEXPECTED_ERROR";
    console.log(`Error Code: ${code}`);
    console.log("Inference requests: 0");
    process.exitCode = 1;
    return;
  }

  let allPassed = true;
  for (const smokeCase of smokeCases) {
    console.log(`${smokeCase.label} Result`);
    console.log(`Requested Model: ${smokeCase.model}`);
    try {
      const result = await client.completeJson({
        model: smokeCase.model,
        messages: [
          {
            role: "system",
            content: "You are an API smoke test. Return only one compact JSON object. Do not use Markdown, explanations, or reasoning text."
          },
          {
            role: "user",
            content: `Return exactly one JSON object with this meaning and nothing else: ${JSON.stringify(smokeCase.expected)}`
          }
        ],
        temperature: 0,
        maxTokens: 100,
        timeoutMs: 20_000
      });

      const matches = semanticMatch(result.data, smokeCase.expected);
      console.log(`Returned Model: ${result.trace.model}`);
      console.log(`Response ID: ${result.trace.responseId}`);
      console.log(`Finish Reason: ${result.trace.finishReason ?? "Not Provided"}`);
      console.log(`Latency: ${result.trace.latencyMs}ms`);
      console.log(`Token Usage: ${usageSummary(result.trace.usage)}`);
      console.log("JSON Parse Success: Yes");
      console.log(`Semantic Match: ${matches ? "Yes" : "No"}`);
      console.log(`Request Count: ${client.requestCount}`);
      if (!matches) allPassed = false;
    } catch (error) {
      allPassed = false;
      const publicError = error instanceof GonkaClientError
        ? error.toPublicError()
        : { code: "UNEXPECTED_ERROR", retryable: false };
      console.log("Returned Model: Not Available");
      console.log("Response ID: Not Available");
      console.log("Finish Reason: Not Available");
      console.log("Latency: Not Available");
      console.log("Token Usage: Not Available");
      console.log(`JSON Parse Success: ${publicError.code === "INVALID_JSON" ? "No" : "Not Available"}`);
      console.log("Semantic Match: No");
      console.log(`Error Code: ${publicError.code}`);
      console.log(`Retryable: ${publicError.retryable ? "Yes" : "No"}`);
      if (Number.isInteger(publicError.status)) {
        console.log(`HTTP Status: ${publicError.status}`);
      }
      console.log(`Request Count: ${client.requestCount}`);
    }
  }

  console.log(`Inference requests: ${client.requestCount}`);
  console.log("Automatic retries: 0");
  console.log("Raw model content displayed: No");
  if (!allPassed || client.requestCount !== 2) process.exitCode = 1;
}

run().catch(() => {
  console.log("Error Code: UNEXPECTED_ERROR");
  console.log("Raw model content displayed: No");
  process.exitCode = 1;
});
