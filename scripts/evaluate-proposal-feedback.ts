#!/usr/bin/env bun
import { proposalFeedbackReport } from '../src/awareness/evaluation/proposal-feedback-evaluation.ts';
console.log(JSON.stringify(proposalFeedbackReport(), null, 2));
