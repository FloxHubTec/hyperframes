// A shelf of videos remixed in the Studio app: each card plays HeyGen's remix on hover, credits the original
// (linked to its post), and says how to remix it yourself. Originals are never hosted here.
export const RemixShelf = ({ items, tall = false }) => {
  // Hover previews follow the visitor's reduced-motion setting, known on the first render; the film is a button, so
  // playing it on purpose works for keyboard and touch, and under reduced motion.
  const shelfRef = useRef(null);
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const follow = (event) => {
      setReduced(event.matches);
      // Turned on mid-visit: stop any hover preview that is running.
      if (event.matches) for (const v of shelfRef.current?.querySelectorAll("video") ?? []) if (v.dataset.hover) v.pause();
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  const RemixCard = ({ item }) => {
    const videoRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [chosen, setChosen] = useState(false);
    const preview = (on) => {
      const v = videoRef.current;
      if (!v || chosen) return;
      if (on && !reduced) {
        v.dataset.hover = "1";
        v.play().catch(() => {});
      } else if (!on) {
        delete v.dataset.hover;
        v.pause();
        v.currentTime = 0;
      }
    };
    const toggle = () => {
      const v = videoRef.current;
      if (!v) return;
      // A chosen film plays with its sound; hover previews stay muted.
      if (chosen && !v.paused) {
        v.pause();
        v.muted = true;
        setChosen(false);
      } else {
        delete v.dataset.hover;
        v.muted = false;
        v.play().catch(() => {});
        setChosen(true);
      }
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
        <button
          type="button"
          className="relative block w-full cursor-pointer border-0 bg-zinc-100 p-0 dark:bg-zinc-900"
          style={{ aspectRatio: item.ratio }}
          aria-label={`${chosen ? "Pause" : "Play with sound:"} ${item.name}, remixed in HyperFrames`}
          aria-pressed={chosen}
          onMouseEnter={() => preview(true)}
          onMouseLeave={() => preview(false)}
          onClick={toggle}
        >
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover"
            src={item.result}
            poster={item.resultPoster}
            preload="none"
            muted
            loop
            playsInline
          />
        </button>
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
    <div ref={shelfRef} className={`not-prose my-6 grid gap-4 ${tall ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"}`}>
      {items.map((item) => <RemixCard key={item.id} item={item} />)}
    </div>
  );
};
