/** Separate, unpackaged integration entry. No production URL can enable it. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardRoot } from './brief/host/DashboardRoot';
import './styles/globals.css';
import { localIntegrationHref } from './brief/host/local-entry';
const initial = localIntegrationHref(window.location.href);
if (initial !== window.location.href) window.history.replaceState(window.history.state, '', initial);
createRoot(document.getElementById('root')!).render(<DashboardRoot integration />);
