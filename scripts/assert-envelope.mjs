// Reads one elv stdout capture on stdin and asserts the documented envelope
// contract: exactly one JSON object, v === 1, and ok agreeing with the exit
// code the caller observed. Exits 0 when the capture holds, 1 with a reason on
// stderr when it does not.
//
//   elv spec status | node scripts/assert-envelope.mjs 0
//
// Shared by scripts/smoke.sh so every smoke row checks the same contract.

const expectedExit = Number(process.argv[2]);
if (!Number.isInteger(expectedExit)) {
  process.stderr.write("usage: assert-envelope.mjs <expected-exit-code>\n");
  process.exit(2);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  const fail = (reason) => {
    process.stderr.write(`${reason}\n`);
    process.exit(1);
  };

  const text = raw.trim();
  if (text.length === 0) fail("stdout was empty; expected one JSON envelope");
  if (text.includes("\n")) fail("stdout spanned multiple lines; expected exactly one JSON envelope");

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    fail(`stdout was not JSON: ${error.message}`);
  }

  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    fail("stdout JSON was not an object");
  }
  if (envelope.v !== 1) fail(`envelope v was ${JSON.stringify(envelope.v)}, expected 1`);

  const expectedOk = expectedExit === 0;
  if (envelope.ok !== expectedOk) {
    fail(`envelope ok was ${JSON.stringify(envelope.ok)} for exit ${expectedExit}`);
  }
  if (!expectedOk && (envelope.error === null || typeof envelope.error !== "object")) {
    fail("error envelope carried no error object");
  }
});
