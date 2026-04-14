import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: 'AIzaSyCFTZlEUhUz_tt-d0SQT7how7GrJxLudyo',
    authDomain: 'manageme-7e663.firebaseapp.com',
    projectId: 'manageme-7e663',
    storageBucket: 'manageme-7e663.firebasestorage.app',
    messagingSenderId: '353413848532',
    appId: '1:353413848532:web:35a92e409b658824eb8a41',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);