/**
 * Adapter: PieceToolRegistry over Jarvis' ToolRegistry. The signatures align
 * almost 1:1; this file projects field names and unwraps the description for
 * the listing API.
 */

import type {
  PieceToolDescription,
  PieceToolRegistry,
} from "../jarvis-pieces/types";
import type { ToolRegistry } from "../../actions/tools/registry";
import { collapseTrustedTrailer } from "../../roles/untrusted.ts";

export class JarvisToolRegistryAdapter implements PieceToolRegistry {
  constructor(private readonly registry: ToolRegistry) {}

  has(name: string): boolean {
    return this.registry.has(name);
  }

  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    // A carrier is collapsed; EVERYTHING ELSE passes through untouched.
    //
    // Both halves matter. A tool may return a carrier holding page text plus a
    // repo-authored trailer (roles/untrusted.ts), and this adapter's value is
    // serialised to JSON for the workflow sandbox
    // (sandbox-api/routes/jarvis-tools.ts), where a class instance would become
    // `{"untrusted":...,"trustedTrailer":...}` -- leaking the internal shape and
    // splitting the text in two.
    //
    // But this value also becomes a durable EFFECT RECEIPT: service-backends.ts
    // passes it to `effects.invoke` as the result a resumed run replays instead
    // of acting again. So it must not be stringified. Using `toolReturnText`
    // here turned every object return into JSON and changed a committed
    // receipt's `result` from the tool's own value to a string of it -- caught by
    // `cancellation-authority.integration.test.ts`. `collapseTrustedTrailer`
    // touches a carrier and nothing else.
    //
    // NOTE: this path does NOT frame the result, for any tool. That is a
    // pre-existing gap in the workflow sandbox, not something #560 introduced or
    // closes.
    return collapseTrustedTrailer(await this.registry.execute(name, params));
  }

  describe(name: string): PieceToolDescription | null {
    const tool = this.registry.get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      parameters: tool.parameters,
    };
  }

  listNames(category?: string): string[] {
    return this.registry.list(category).map((t) => t.name);
  }
}
