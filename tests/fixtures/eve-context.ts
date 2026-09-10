import {
  ContextContainer,
  contextStorage as sdkContextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  serializeContext as sdkSerializeContext,
} from "../../node_modules/eve/dist/src/context/serialize.js";

export { ContextContainer };
export { deserializeContext } from "../../node_modules/eve/dist/src/context/serialize.js";

// Eve 0.52.5 declares an optional AlsContext.localDevRequest but implements it
// with a getter that can return undefined. Hide that unused property from the
// fixture's type view for exactOptionalPropertyTypes; keep the real container,
// storage and serialization at runtime, including its durable state.
function durableContext(context: ContextContainer): Omit<ContextContainer, "localDevRequest"> {
  return context;
}

export const contextStorage = {
  run<T>(context: ContextContainer, callback: () => T): T {
    return sdkContextStorage.run(durableContext(context), callback);
  },
};

export function serializeContext(context: ContextContainer): Record<string, unknown> {
  return sdkSerializeContext(durableContext(context));
}
