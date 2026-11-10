import React from 'react';
import type { FlowStepNode } from './useWorkflowEditor';

/** Authored source is text, never evaluated by the editor or a variable picker. */
export function CodeStepFields({ step, readOnly, onChange }: {
  step: FlowStepNode; readOnly?: boolean; onChange(value: { code: string; packageJson: string }): void;
}) {
  const source = step.settings?.sourceCode ?? { code: '', packageJson: '' };
  let invalidPackage = false;
  try { const value = JSON.parse(source.packageJson); invalidPackage = !value || typeof value !== 'object' || Array.isArray(value); }
  catch { invalidPackage = true; }
  return <div className="wf-props__inputs">
    <p className="wf-props__hint">Review this code and its packages before allowing CODE steps in Flow permissions. Saving these fields does not allow execution.</p>
    <label htmlFor={`code-source-${step.name}`}>JavaScript source</label>
    <textarea id={`code-source-${step.name}`} className="wf-props__sample-textarea" rows={12} spellCheck={false} readOnly={readOnly}
      value={source.code} onChange={event => onChange({ ...source, code: event.target.value })} />
    <label htmlFor={`code-packages-${step.name}`}>package.json</label>
    <textarea id={`code-packages-${step.name}`} className="wf-props__sample-textarea" rows={6} spellCheck={false} readOnly={readOnly}
      aria-invalid={invalidPackage} aria-describedby={invalidPackage ? `code-packages-error-${step.name}` : undefined}
      value={source.packageJson} onChange={event => onChange({ ...source, packageJson: event.target.value })} />
    {invalidPackage && <p id={`code-packages-error-${step.name}`} role="alert">Enter a valid package.json object. Your text is retained.</p>}
  </div>;
}
