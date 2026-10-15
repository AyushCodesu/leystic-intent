import { Bookmark, ChartNoAxesColumn, Heart, MessageCircle, Repeat2, Upload } from "lucide-react";
import { XMark } from "@/components/x/XMark";
import { BrandImage } from "./BrandImage";
import { BrandWord } from "./BrandWord";
import { EyebrowLink } from "./EyebrowLink";
import {
  X_CALENDLY_PLUS,
  X_LICENSE_RAN_OUT,
  X_OWN_RECORDER,
  X_ROUND_ROBIN,
  X_SELF_HOST,
  X_TOO_EXPENSIVE,
  xPostUrl,
  type MockXPost,
} from "./xContent";

/** X's own short counts, rounded down: 848, 3.9K, 16K. Zero shows nothing, as on X. */
function xCount(value: number): string {
  if (value === 0) {
    return "";
  }
  if (value < 1000) {
    return String(value);
  }
  return value < 10000 ? `${Math.floor(value / 100) / 10}K` : `${Math.floor(value / 1000)}K`;
}

/** X's blue check, drawn from its own badge path. */
function VerifiedBadge() {
  return (
    <svg viewBox="0 0 22 22" className="x-post-verified" aria-label="Verified account">
      <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
    </svg>
  );
}

/** One saved X post, drawn the way X draws one in a timeline. */
function XPostCard({ post }: { post: MockXPost }) {
  const actions = [
    { Icon: MessageCircle, count: post.replies, label: "Replies" },
    { Icon: Repeat2, count: post.reposts, label: "Reposts" },
    { Icon: Heart, count: post.likes, label: "Likes" },
    { Icon: ChartNoAxesColumn, count: post.views, label: "Views" },
  ];
  return (
    <a className="x-post" href={xPostUrl(post)} target="_blank" rel="noreferrer">
      {/* X's CDN art; the Next image proxy adds nothing here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="x-post-avatar" src={post.avatar.replace("_normal.", "_bigger.")} alt="" width={40} height={40} />
      <span className="x-post-body">
        <span className="x-post-head">
          <strong>{post.name}</strong>
          {post.verified ? <VerifiedBadge /> : null}
          <span className="x-post-muted">
            @{post.username} · {post.date}
          </span>
          <XMark className="x-post-logo" aria-hidden="true" />
        </span>
        {post.replyingTo ? (
          <span className="x-post-muted">
            Replying to <span className="x-post-link">{post.replyingTo.map((handle) => `@${handle}`).join(" ")}</span>
          </span>
        ) : null}
        <span className="x-post-text">
          {post.text}
          {post.more ? <span className="x-post-link x-post-more">Show more</span> : null}
        </span>
        <span className="x-post-actions">
          {actions.map(({ Icon, count, label }) => (
            <span key={label} aria-label={`${count} ${label}`}>
              <Icon />
              {xCount(count)}
            </span>
          ))}
          <span className="x-post-share">
            <Bookmark />
            <Upload />
          </span>
        </span>
      </span>
    </a>
  );
}

const TILES: { title: string; caption: string; tone: string; posts: MockXPost[] }[] = [
  {
    title: "Asking for what you sell",
    caption: "Someone wants a tool like yours and says what it has to do.",
    tone: "pastel-pink",
    posts: [X_ROUND_ROBIN, X_SELF_HOST],
  },
  {
    title: "Leaving a competitor",
    caption: "A license ran out or the price went up, and they are asking what to use instead.",
    tone: "pastel-teal",
    posts: [X_LICENSE_RAN_OUT, X_TOO_EXPENSIVE],
  },
  {
    title: "Building their own",
    caption: "They built or vibe coded their own. Big posts are ranked by reach, so a reply gets seen.",
    tone: "pastel-mint",
    posts: [X_CALENDLY_PLUS, X_OWN_RECORDER],
  },
];

/** X leads as three product tiles, one per kind of post the X scan keeps. */
export function MarketingXTiles() {
  return (
    <section id="x" className="x-tiles">
      <header className="left-heading">
        <EyebrowLink href="#features">
          <BrandWord name="X" label="X leads" />
        </EyebrowLink>
        <h2>Buyers on X say it out loud.</h2>
        <p>
          People on <BrandWord name="X" /> ask for recommendations, complain about what they pay,
          and post that they built their own. lurk searches <BrandWord name="X" /> for those posts
          about your competitors and your category, reads each one, and keeps the ones worth a
          reply.
        </p>
      </header>
      {/* The X launch video. It has sound, so it waits for a play click instead of autoplaying muted. */}
      <video
        className="x-video"
        src="/videos/x-leads.mp4"
        poster="/videos/x-leads-poster.jpg"
        controls
        playsInline
        preload="metadata"
        aria-label="lurk finding X posts that ask for a product like yours"
      />
      <div className="three-up">
        {TILES.map((tile) => (
          <figure className="pastel-tile" key={tile.title}>
            <div className={`pastel-art x-art ${tile.tone}`}>
              <span className="x-art-product">
                <BrandImage name={tile.posts[0].product.name} domain={tile.posts[0].product.domain} size={14} />
                Found for {tile.posts[0].product.name}
              </span>
              {tile.posts.map((post) => (
                <XPostCard key={post.id} post={post} />
              ))}
            </div>
            <figcaption>
              <strong>{tile.title}</strong> {tile.caption}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
