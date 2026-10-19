import type { ComponentType } from 'react';
import { WelcomeView } from '../views/welcome/index.tsx';
import { ExplainerView } from '../views/explainer/index.tsx';
import { GoogleView } from '../views/google/index.tsx';
import { InterviewView } from '../views/interview/index.tsx';
import { TourView } from '../views/tour/index.tsx';
import { PebbleTourView } from '../views/pebble-tour/index.tsx';
import { ActivationView } from '../views/activation/index.tsx';
import { BuildView } from '../views/build/index.tsx';
import { ResultView } from '../views/result/index.tsx';
import type { ViewName } from './matrix';

/** The actual controlled views, keyed by fixture view name. */
export const views: Record<ViewName, ComponentType<any>> = {
  welcome: WelcomeView, explainer: ExplainerView, google: GoogleView, interview: InterviewView, tour: TourView,
  'pebble-tour': PebbleTourView, activation: ActivationView, build: BuildView, result: ResultView,
};
