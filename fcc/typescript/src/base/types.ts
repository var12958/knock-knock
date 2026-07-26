/**
 * @notice Minimal Framework types mirroring the fce-sign TypeScript scaffold.
 * @dev In a real deployment these are provided by the Flare fce-sign framework
 *      in `typescript/src/base/`. This local copy lets you run and test the
 *      handler logic before integrating into the full TEE stack.
 */

export type HandlerFunc = (
  msg: string,
) => Promise<[string | null, number, string | null]>;

export type RegisterFunc = (framework: Framework) => void;

export type ReportStateFunc = () => unknown;

export type ResetStateFunc = () => void;

export interface HandlerEntry {
  opType: string;
  opCommand: string;
  handler: HandlerFunc;
}

export class Framework {
  private handlers: HandlerEntry[] = [];

  handle(opType: string, opCommand: string, handler: HandlerFunc): void {
    this.handlers.push({ opType, opCommand, handler });
  }

  lookup(opType: string, opCommand: string): HandlerFunc | null {
    const entry = this.handlers.find(
      (h) => h.opType === opType && h.opCommand === opCommand,
    );
    return entry ? entry.handler : null;
  }
}
