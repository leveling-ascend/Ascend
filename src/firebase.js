import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// TODO: fill this in with ASCEND's own Firebase project config
// (Firebase console → Project settings → General → Your apps → SDK setup and configuration).
// This should be a *separate* Firebase project from your Life RPG app's project.
const firebaseConfig = {
  apiKey: "AIzaSyDlTinKtLQio86jSa47ILkbggnNXr8-GWg",
  authDomain: "ascend-dc1d0.firebaseapp.com",
  projectId: "ascend-dc1d0",
  storageBucket: "ascend-dc1d0.firebasestorage.app",
  messagingSenderId: "229839647072",
  appId: "1:229839647072:web:e4c5c85592cea4b921ae05",
  measurementId: "G-YXEFVYQXHV"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Single collection holding ASCEND's one shared document ("main").
export const ASCEND_COLLECTION = "ascend_quest";
