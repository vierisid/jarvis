#!/usr/bin/env bun
import { goalRelevanceReport } from '../src/awareness/evaluation/goal-relevance-evaluation.ts';
console.log(JSON.stringify(goalRelevanceReport(), null, 2));
