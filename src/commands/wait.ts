import { waitForOperation } from "../core/wait-operation";
import type { WaitOptions } from "../core/wait-operation";

export { waitForOperation };

export async function handleWait(options: WaitOptions): ReturnType<typeof waitForOperation> {
  return waitForOperation(options);
}
