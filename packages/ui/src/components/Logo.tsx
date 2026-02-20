import React from 'react';

interface LogoProps {
  size?: number;
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ size = 32, className = "" }) => {
  return (
    <div className={`relative flex items-center justify-center ${className}`} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-sm"
      >
        {/* Background rounded square with gradient */}
        <defs>
          <linearGradient id="logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6366f1" /> {/* Indigo 500 */}
            <stop offset="100%" stopColor="#a855f7" /> {/* Violet 500 */}
          </linearGradient>
        </defs>
        
        <rect width="100" height="100" rx="24" fill="url(#logo-gradient)" />
        
        {/* Stylized 'A' */}
        <path
          d="M50 25L25 75H35L50 45L65 75H75L50 25Z"
          fill="white"
        />
        
        {/* Connection node / Agentic spark */}
        <circle cx="50" cy="25" r="8" fill="white" />
        <circle cx="50" cy="25" r="4" fill="#6366f1" />
        
        {/* Crossbar of the A as a data link */}
        <rect x="40" y="55" width="20" height="4" rx="2" fill="white" fillOpacity="0.8" />
      </svg>
    </div>
  );
};
