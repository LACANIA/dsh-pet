import { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makePetConfigSection, petBridge, en, zh } from '../../src/client/settings.ts';
import { makePetUI } from '../../src/client/pet.ts';

petBridge.current = window.initialConfig.main.pets;
petBridge.template = petBridge.current[0];
const dictionary = new URLSearchParams(location.search).get('lang') === 'zh' ? zh : en;
const Section = makePetConfigSection({
  h: jsx,
  useState,
  useEffect,
  useRef,
  useCallback,
  t: (key) => dictionary[key] ?? key,
});
const View =
  new URLSearchParams(location.search).get('view') === 'pet'
    ? makePetUI({ h: jsx, useState, useEffect, useRef })
    : Section;
createRoot(document.getElementById('root')).render(jsx(View, {}));
