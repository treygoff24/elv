import { emitAndExit } from "../core/errors";
import { waitForOperation } from "../core/wait-operation";
import type { WaitOptions } from "../core/wait-operation";

export { waitForOperation };

export async function handleWait(options: WaitOptions): Promise<never> {
  const result = await waitForOperation(options);
  emitAndExit(result.env, result.exitCode);
}
