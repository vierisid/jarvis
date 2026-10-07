/** Keep the governed-piece document handoff when re-vendoring the engine.
 * Exact anchors fail on upstream drift instead of silently omitting the gate. */
export const PIECE_EXECUTOR_PATH = 'packages/server/engine/src/lib/handler/piece-executor.ts';
const guardImport = "import { authorizePieceDispatch } from '../../../../../../../runtime/piece-effect-guard'";
const conversion = `        const backwardCompatibleContext = backwardCompatabilityContextUtils.makeActionContextBackwardCompatible({
            contextVersion: piece.getContextInfo?.().version,
            context,
        })
`;
const gate = `        // Jarvis: a verified piece's action passes the daemon's Authority
        // boundary before it touches the network. Ungoverned pieces are not
        // asked about and run untouched. Re-runs on RESUME re-authorize rather
        // than trusting the decision that parked the step.
        const governance = await authorizePieceDispatch({
            apiUrl: constants.internalApiUrl,
            engineToken: constants.engineToken,
            piece: action.settings.pieceName,
            action: action.settings.actionName,
            stepName: action.name,
            executionPath: executionState.currentPath.path,
            input: processedInput,
        })
        if (governance.governed && governance.dispatch === 'approval_required') {
            // Same pause the jarvis-tool piece uses: park on the approval
            // waitpoint without running the action.
            params.hookResponse = { ...params.hookResponse, type: 'paused' }
        }
        // The guard applies the approved document to processedInput before conversion.
`;
const output = `        const output = (governance.governed && governance.dispatch === 'approval_required')
            ? { approval: governance.approval }
            : await runMethodToExecute(backwardCompatibleContext)`;
export function applyPieceApprovalPatch(source: string): string {
  const replaceOnce = (text: string, from: string, to: string) => {
    if (text.split(from).length !== 2) throw Error('Piece approval patch anchor drift');
    return text.replace(from, to);
  };
  if (source.includes('await authorizePieceDispatch({')) {
    if (!source.includes(guardImport) || !source.includes(gate + conversion + output)) throw Error('Incomplete piece approval patch');
    return source;
  }
  source = replaceOnce(source, conversion, '');
  source = replaceOnce(source, '        const output = await runMethodToExecute(backwardCompatibleContext)', gate + conversion + output);
  return guardImport + '\n' + source;
}
