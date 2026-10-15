#!/usr/bin/env bun
import { routineEvaluationReport } from '../src/awareness/evaluation/routine-evaluation.ts';
console.log(JSON.stringify(routineEvaluationReport(), null, 2));
