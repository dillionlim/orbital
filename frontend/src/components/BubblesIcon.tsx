import React from 'react';
import type { SVGProps } from 'react';

export default function BubblesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1150 1350"
      fill="currentColor"
      {...props}
    >
      <defs>
        <mask id="arc-subtraction-mask">
          {/* Fill the whole canvas with white so the whole circle is visible by default */}
          <rect x="2500" y="300" width="1500" height="1500" fill="#FFFFFF" />
          
          {/* Draws transparent arc */}
          <path 
            d="M3080.76 789C3274.61 788.865 3431.86 945.903 3432 1139.75 3432 1140.3 3432 1140.85 3432 1141.4" 
            stroke="#000000" 
            strokeWidth="64.1667" 
            strokeLinecap="round" 
            fill="none" 
          />
        </mask>
      </defs>

      {/* SVG layer translation */}
      <g transform="translate(-2595 -389)">
        
        {/* Main Bubble Circle */}
        <path 
          d="M2618 1133C2618 874.531 2828.87 665 3089 665 3349.13 665 3560 874.531 3560 1133 3560 1391.47 3349.13 1601 3089 1601 2828.87 1601 2618 1391.47 2618 1133Z" 
          fill="currentColor" 
          mask="url(#arc-subtraction-mask)"
        />

        {/* Large Sparkle */}
        <path d="M3405.4 614C3486.31 613.943 3551.94 679.711 3552 760.897 3552 761.126 3552 761.355 3552 761.584" stroke="currentColor" strokeWidth="27.5" strokeMiterlimit="8" fill="none" />
        <path d="M146.398 0C227.307-0.0568244 292.944 65.7112 293 146.897 293 147.126 293 147.355 292.999 147.584" stroke="currentColor" strokeWidth="27.5" strokeMiterlimit="8" fill="none" transform="matrix(-1 0 0 1 3845 614)" />
        <path d="M146.398 0C227.307-0.0564385 292.943 65.4881 293 146.398 293 146.627 293 146.855 292.999 147.084" stroke="currentColor" strokeWidth="27.5" strokeMiterlimit="8" fill="none" transform="matrix(1 0 0 -1 3259 614)" />
        <path d="M3698.6 614C3617.69 614.056 3552.06 548.512 3552 467.602 3552 467.373 3552 467.144 3552 466.916" stroke="currentColor" strokeWidth="27.5" strokeMiterlimit="8" fill="none" />

        {/* Small Sparkle */}
        <path d="M3198.44 490.5C3248.69 490.465 3289.46 531.402 3289.5 581.936 3289.5 582.078 3289.5 582.221 3289.5 582.363" stroke="currentColor" strokeWidth="20.625" strokeMiterlimit="8" fill="none" />
        <path d="M90.9363 0C141.194-0.0354436 181.965 40.9017 182 91.4357 182 91.5781 182 91.7206 181.999 91.863" stroke="currentColor" strokeWidth="20.625" strokeMiterlimit="8" fill="none" transform="matrix(-1 0 0 1 3471.5 490.5)" />
        <path d="M90.9364 0C141.194-0.0350575 181.965 40.6786 182 90.9366 182 91.0788 182 91.2209 181.999 91.3631" stroke="currentColor" strokeWidth="20.625" strokeMiterlimit="8" fill="none" transform="matrix(1 0 0 -1 3107.5 490.5)" />
        <path d="M3380.56 490.5C3330.31 490.535 3289.53 449.821 3289.5 399.563 3289.5 399.421 3289.5 399.279 3289.5 399.137" stroke="currentColor" strokeWidth="20.625" strokeMiterlimit="8" fill="none" />

      </g>
    </svg>
  );
}
