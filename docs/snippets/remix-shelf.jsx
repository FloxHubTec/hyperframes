// A shelf of videos remixed in the Studio app: each card plays HeyGen's remix on hover, credits the original
// (linked to its post), and says how to remix it yourself. Originals are never hosted here.
export const RemixShelf = ({ items, tall = false }) => {
  const RemixCard = ({ item }) => {
    const videoRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const play = () => videoRef.current?.play().catch(() => {});
    const stop = () => {
      const v = videoRef.current;
      if (v) { v.pause(); v.currentTime = 0; }
    };
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(item.post);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {}
    };
    return (
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="relative bg-zinc-100 dark:bg-zinc-900" style={{ aspectRatio: item.ratio }} onMouseEnter={play} onMouseLeave={stop} onClick={() => (videoRef.current?.paused ? play() : videoRef.current.pause())}>
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover"
            src={item.result}
            poster={item.resultPoster}
            preload="none"
            muted
            loop
            playsInline
            controls={open}
            aria-label={`${item.name}, remixed in HyperFrames`}
          />
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          <strong className="text-sm leading-snug">{item.name}</strong>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Remix of a video by{" "}
            <a href={item.post} target="_blank" rel="noopener noreferrer">{item.handle}</a>
          </span>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-1 self-start rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white dark:bg-white dark:text-zinc-900"
          >
            Remix in Studio
          </button>
          {open && (
            <div className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
              Copy the original's link, then paste it in <strong>Reference</strong> on the Studio app's Home.{" "}
              <button type="button" onClick={copy} className="font-semibold underline">
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className={`not-prose my-6 grid gap-4 ${tall ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"}`}>
      {items.map((item) => <RemixCard key={item.id} item={item} />)}
    </div>
  );
};
