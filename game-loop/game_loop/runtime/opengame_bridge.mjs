import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [requestPath, eventsPath, resultPath] = process.argv.slice(2);
if (!requestPath || !eventsPath || !resultPath) {
  throw new Error('usage: node opengame_bridge.mjs REQUEST EVENTS RESULT');
}

const request = JSON.parse(await readFile(requestPath, 'utf8'));
await writeFile(eventsPath, '', 'utf8');

try {
  const sdkModule = request.sdk_module || '@opengame/sdk';
  const sdkSpecifier = sdkModule.startsWith('/')
    ? pathToFileURL(sdkModule).href
    : sdkModule;
  const { query } = await import(sdkSpecifier);
  let finalResult = null;
  for await (const message of query({
    prompt: request.prompt,
    options: { ...request.options, env: { ...process.env } },
  })) {
    await appendFile(eventsPath, `${JSON.stringify(message)}\n`, 'utf8');
    if (message?.type === 'result') finalResult = message;
  }
  await writeFile(
    resultPath,
    `${JSON.stringify({ ok: true, final_result: finalResult })}\n`,
    'utf8',
  );
} catch (error) {
  const failure = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  await writeFile(resultPath, `${JSON.stringify(failure)}\n`, 'utf8');
  process.exitCode = 1;
}
