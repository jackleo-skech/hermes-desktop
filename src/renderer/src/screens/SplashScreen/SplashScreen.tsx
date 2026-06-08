import { useEffect, useRef } from "react";
import startVid from "../../assets/startvid.mp4";
import splashLogo from "../../assets/hermes-one.svg";

interface SplashScreenProps {
  onFinished: () => void;
  status?: string;
}

function SplashScreen({
  onFinished,
  status,
}: SplashScreenProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    onFinished();
  }, [onFinished]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = 1;
    video.play().catch(() => {
      // autoplay blocked or video error — silently fall back to black bg
    });
  }, []);

  return (
    <div className="splash-screen">
      <video
        ref={videoRef}
        className="splash-bg"
        src={startVid}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        style={{ display: "block", objectFit: "cover" }}
      />
      <img className="splash-logo" src={splashLogo} alt="Hermes One" />
      {status && <div className="splash-status">{status}</div>}
    </div>
  );
}

export default SplashScreen;
