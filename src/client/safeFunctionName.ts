import {
  type FunctionReference,
  type FunctionReference_future,
  type FunctionType,
  type FunctionVisibility,
  getFunctionAddress,
  getFunctionName,
} from "convex/server";

export function safeFunctionName(
  f:
    | FunctionReference<FunctionType, FunctionVisibility>
    | FunctionReference_future<FunctionType, FunctionVisibility>,
) {
  const address = getFunctionAddress(f);
  return (
    address.name ||
    (address.reference && address.reference.split("/").slice(2).join("/")) ||
    (address.functionHandle &&
      address.functionHandle.slice("function://".length)) ||
    getFunctionName(f)
  );
}
