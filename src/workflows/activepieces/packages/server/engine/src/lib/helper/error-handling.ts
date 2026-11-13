import { CodeAction, FlowRunStatus, isNil, PieceAction } from '@activepieces/shared'
import { EngineConstants } from '../handler/context/engine-constants'
import {  FlowExecutorContext } from '../handler/context/flow-execution-context'

export async function runWithExponentialBackoff<T extends CodeAction | PieceAction>(
    executionState: FlowExecutorContext,
    action: T,
    constants: EngineConstants,
    requestFunction: RequestFunction<T>,
    attemptCount = 1,
): Promise<FlowExecutorContext> {
    const resultExecutionState = await requestFunction({ action, executionState, constants })
    const retryEnabled = action.settings.errorHandlingOptions?.retryOnFailure?.value
    if (
        executionFailedWithRetryableError(resultExecutionState) &&
        attemptCount < constants.retryConstants.maxAttempts &&
        retryEnabled &&
        isNil(constants.stepNameToTest)
    ) {
        const backoffTime = Math.pow(constants.retryConstants.retryExponential, attemptCount) * constants.retryConstants.retryInterval
        await new Promise(resolve => setTimeout(resolve, backoffTime))
        return runWithExponentialBackoff(executionState, action, constants, requestFunction, attemptCount + 1)
    }

    return resultExecutionState
}

// === JARVIS PATCH: a refused dispatch is never continued past ===
// A step the daemon would not admit or authorize (denied, held for Kill, not
// approved) did not run. "Continue on failure" is for a step that ran and
// failed; it must not turn a refusal of Authority into a step to move past.
// The executors add the failed context they return when the refusal came from
// the dispatch check or, for a step that asks Jarvis from inside its run (a
// Jarvis piece, an approval), from there (piece-effect-guard continuableFailure).
export const refusedDispatches = new WeakSet<FlowExecutorContext>()
// === END JARVIS PATCH ===

export async function continueIfFailureHandler(
    executionState: FlowExecutorContext,
    action: CodeAction | PieceAction,
    constants: EngineConstants,
): Promise<FlowExecutorContext> {
    const continueOnFailure = action.settings.errorHandlingOptions?.continueOnFailure?.value

    if (
        executionState.verdict.status === FlowRunStatus.FAILED &&
        continueOnFailure &&
        !refusedDispatches.has(executionState) &&
        isNil(constants.stepNameToTest)
    ) {
        return executionState
            .setVerdict({ status: FlowRunStatus.RUNNING })
    }

    return executionState
}


const executionFailedWithRetryableError = (flowExecutorContext: FlowExecutorContext): boolean => {
    return flowExecutorContext.verdict.status === FlowRunStatus.FAILED
}

type Request<T extends CodeAction | PieceAction> = {
    action: T
    executionState: FlowExecutorContext
    constants: EngineConstants
}

type RequestFunction<T extends CodeAction | PieceAction> = (request: Request<T>) => Promise<FlowExecutorContext>

