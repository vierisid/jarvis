import React, { useState } from "react";
import type { CSSProperties } from "react";
import { useTheme } from "../../v2/shell/useTheme";
import { BriefButton } from "../components/controls";
import { BriefBrand } from "./BriefBrand";
import reference from "./figma-reference.json";
import "./index.css";
import "./specimen.css";

// Explicit developer specimens, never a live room's missing-data fallback.
export function StyleSpecimen() {
  const [theme, setTheme] = useTheme();
  const [largeText, setLargeText] = useState(false);
  const [compact, setCompact] = useState(false);
  return <main className="brief-root brief-specimen" data-brief-theme={theme}
    style={{ "--brief-text-scale": largeText ? 2 : 1 } as CSSProperties}>
    <div className="brief-specimen__inner">
      <header className="brief-specimen__header">
        <BriefBrand />
        <div><p className="brief-type-data brief-secondary">D-02 · Style reference</p>
          <h1 className="brief-type-room-title">The Brief materials</h1>
          <p className="brief-type-body brief-secondary">Approved Figma type, surfaces and progress. All content below is illustrative.</p></div>
        <div className="brief-specimen__controls" aria-label="Specimen controls">
          <BriefButton className="brief-type-control" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Switch to {theme === "light" ? "dark" : "light"}</BriefButton>
          <BriefButton className="brief-type-control" aria-pressed={largeText} onClick={() => setLargeText(!largeText)}>{largeText ? "100% text" : "200% text"}</BriefButton>
          <BriefButton className="brief-type-control" aria-pressed={compact} onClick={() => setCompact(!compact)}>{compact ? "Wide paper" : "Compact paper"}</BriefButton>
        </div>
      </header>

      <section className="brief-specimen__section" aria-labelledby="material-heading">
        <h2 id="material-heading" className="brief-type-section-heading">One object. One silhouette.</h2>
        <p className="brief-type-body brief-secondary">Canvas, contained card, raised paper and floating menu.</p>
        <div className="brief-specimen__materials">
          <article className="brief-surface brief-specimen__material">
            <h3 className="brief-type-card-heading">Contained card</h3>
            <p className="brief-type-body brief-secondary">Flat surface. Rounded lower corners. Sharp upper-right.</p>
            <span className="brief-type-data brief-tertiary">14 / 0 / 14 / 14</span>
          </article>
          <div className="brief-paper-object">
            <article className="brief-surface brief-surface--paper brief-specimen__material">
              <h3 className="brief-type-card-heading">Raised paper</h3>
              <p className="brief-type-body brief-secondary">The face, backing and shadow share the same curve.</p>
              <span className="brief-type-data brief-secondary">12 / 0 / 12 / 12</span>
            </article>
          </div>
          <article className="brief-surface brief-surface--menu brief-specimen__material">
            <h3 className="brief-type-card-heading">Floating menu</h3>
            <p className="brief-type-body brief-secondary">One surface above the workspace.</p>
            <span className="brief-type-data brief-secondary">10 / 0 / 10 / 10</span>
            <div className="brief-specimen__menu-rows"><p className="brief-type-body">Connections</p><p className="brief-type-body">Library</p></div>
          </article>
        </div>
      </section>

      <section className="brief-specimen__section" aria-labelledby="paper-heading">
        <h2 id="paper-heading" className="brief-type-section-heading">A readable decision</h2>
        <div className={`brief-specimen__paper-stage${compact ? " brief-specimen__paper-stage--compact" : ""}`}>
          <div className="brief-paper-object">
            <article className="brief-surface brief-surface--paper">
              <div className="brief-surface__clip brief-specimen__document">
                <div className="brief-specimen__document-heading"><h3 className="brief-type-card-heading">Follow-up draft</h3><span className="brief-status brief-status--attention">Needs your review</span></div>
                <p className="brief-type-utility brief-secondary">To Alex</p>
                <h4 className="brief-type-compact-heading">Our pilot: next steps</h4>
                <p className="brief-type-body">Hi Alex,</p>
                <p className="brief-type-body">Let’s start with meeting follow-ups.</p>
                <p className="brief-type-body brief-paper-highlight">Does [pilot date] work for you?</p>
                <p className="brief-type-utility brief-secondary">Review before sending</p>
              </div>
            </article>
          </div>
          <div className="brief-specimen__paper-note">
            <h3 className="brief-type-hero-heading">The follow-up is ready.<br />One detail needs your eyes.</h3>
            <p className="brief-type-body brief-secondary">This specimen tests the document’s material and readable type. Decision actions belong to their later room steps.</p>
          </div>
        </div>
      </section>

      <section className="brief-specimen__section" aria-labelledby="progress-heading">
        <h2 id="progress-heading" className="brief-type-section-heading">One value, one progress treatment</h2>
        <div className="brief-specimen__progress-grid">
          {([['Near zero',1,'near'],['Early',3,'early'],['Middle',6,'middle'],['Near complete',8,'complete']] as const).map(([name,value,tone]) =>
            <div key={name}><h3 className="brief-type-control">{name}</h3>
              <p className="brief-type-data brief-secondary">{value} / 10</p>
              <div className={`brief-progress brief-progress--${tone}`} role="progressbar" aria-label={`${name} example`} aria-valuemin={0} aria-valuemax={10} aria-valuenow={value}>
                {Array.from({length:10},(_,i)=><span key={i} data-complete={i<value} />)}
              </div>
            </div>)}
        </div>
        <div className="brief-specimen__outcomes">
          <div><div className="brief-specimen__figure"><strong className="brief-type-outcome-96-bold">90</strong><span className="brief-type-body brief-secondary">minutes back today</span></div></div>
          <div><div className="brief-specimen__figure"><strong className="brief-type-outcome-43-bold">6</strong><span className="brief-type-data brief-secondary">/ 10 signed</span></div>
            <div className="brief-progress brief-progress--middle" role="progressbar" aria-label="Design partners example" aria-valuemin={0} aria-valuemax={10} aria-valuenow={6}>{Array.from({length:10},(_,i)=><span key={i} data-complete={i<6} />)}</div>
            <p className="brief-type-body-emphasis brief-positive">+2 this week</p></div>
        </div>
        <div className="brief-specimen__statuses"><span className="brief-status brief-status--attention">Needs approval</span><span className="brief-status brief-status--running">Running</span><span className="brief-status brief-status--success">Completed</span><span className="brief-status brief-status--error">Stopped</span><span className="brief-status">Paused</span></div>
      </section>

      <section className="brief-specimen__section" aria-labelledby="type-heading">
        <h2 id="type-heading" className="brief-type-section-heading">Type that holds its place</h2>
        <div className="brief-specimen__type-list">
          {reference.typeStyles.filter(s=>!s.Style.includes('Outcome')).map(s=>{
            const slug=s.Style.replace('Brief / ','').toLowerCase().replaceAll(' ','-');
            return <div key={slug}><span className="brief-type-data brief-tertiary">{s.Size} / {s['Line height']} · {s.Weight}</span><p className={`brief-type-${slug}`}>{s.Style.replace('Brief / ','')}</p></div>;
          })}
        </div>
        <div className="brief-surface brief-specimen__long-values"><h3 className="brief-type-card-heading">Long values and compact labels</h3>
          <p className="brief-type-body">Prepare a follow-up for Alexandra’s international design partnership and confirm the pilot’s success criteria.</p>
          <p className="brief-type-utility brief-secondary">Confirm the pilot date before sending.</p>
          <p className="brief-type-data">alexandra.partnerships@company.example</p>
        </div>
      </section>
      <a className="brief-type-control brief-specimen__return" href="?brief=preview#/_brief_preview">Back to foundation preview</a>
    </div>
  </main>;
}
