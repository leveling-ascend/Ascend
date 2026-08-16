import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: fill this in with ASCEND's own Firebase project config
// (Firebase console → Project settings → General → Your apps → SDK setup and configuration).
// This should be a *separate* Firebase project from your Life RPG app's project.
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Single collection holding ASCEND's one shared document ("main").
export const ASCEND_COLLECTION = "ascend_quest";
