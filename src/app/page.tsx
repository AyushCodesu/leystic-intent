import { ArrowUpRight, Check } from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { MarketingShowcase } from "@/components/marketing/MarketingShowcase";
import { MarketingPeople } from "@/components/marketing/MarketingPeople";
import { MarketingFree } from "@/components/marketing/MarketingFree";
import { MarketingScanCollage } from "@/components/marketing/MarketingScanCollage";
import { MarketingSeoTiles } from "@/components/marketing/MarketingSeoTiles";
import { MarketingXTiles } from "@/components/marketing/MarketingXTiles";
import { OpenSourcePanel } from "@/components/marketing/OpenSourcePanel";
import { MarketingDecisionTiles } from "@/components/marketing/MarketingDecisionTiles";
import { MarketingAnyapi } from "@/components/marketing/MarketingAnyapi";
import { MotionPanel } from "@/components/marketing/MotionPanel";
import { CtaRow } from "@/components/marketing/CtaRow";
import { REPO_URL } from "@/lib/brand";
import "@/components/marketing/marketing.css";
import "@/components/marketing/below-fold.css";
import "@/components/marketing/round-three.css";
import "@/components/marketing/round-four.css";
import "@/components/marketing/anyapi.css";

/** The home page: one feature story under the hero. */
export default function MarketingPage() {
  return (
    <main className="marketing">
      <MotionPanel>
        <MarketingNav />
        <section className="hero-layout" aria-labelledby="marketing-title">
          <div className="hero-copy">
            <h1 id="marketing-title" className="tracking-tight">
              Find people already asking for what you sell.
            </h1>
            <p className="hero-description text-fg-muted" style={{ maxWidth: "620px", marginTop: "1rem" }}>
              Leystic finds public conversations where potential customers are asking for tools, exploring alternatives or describing problems your product solves. See the exact post, why it matches, and what to do next.
            </p>
            <p className="hero-description hero-open" style={{ marginTop: "0.5rem" }}>
              Free to start.{" "}
              <a href={REPO_URL} target="_blank" rel="noopener">
                Open source
                <ArrowUpRight aria-hidden="true" />
              </a>
            </p>
            <CtaRow />
            <div className="hero-promises">
              <span>
                <Check />
                Human-controlled
              </span>
              <span>
                <Check />
                Never auto-posts or DMs
              </span>
              <span>
                <Check />
                Explainable evidence
              </span>
            </div>
          </div>
          <div className="hero-product">
            <MarketingShowcase />
          </div>
        </section>
      </MotionPanel>
      <div className="marketing-body">
        <MarketingPeople />
        <MarketingXTiles />
        <MarketingFree />
        <MarketingScanCollage />
        <MarketingSeoTiles />
        <OpenSourcePanel />
        <MarketingDecisionTiles />
        <MarketingAnyapi />
        <section className="closing-cta">
          <span className="closing-eyebrow">
            Good conversations start with listening
          </span>
          <h2>
            Find the ask.
            <br />
            Bring something useful.
          </h2>
          <CtaRow />
        </section>
        <MarketingFooter />
      </div>
    </main>
  );
}
