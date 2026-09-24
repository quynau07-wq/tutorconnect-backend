import {Router} from 'express';
import {db} from '../config/firebase.js';
import {requireAuth} from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (request, response) => {
  const uid = request.firebaseUser!.uid;
  const snapshot = await db.collection('users').doc(uid).get();

  response.json({
    auth: {
      uid,
      email: request.firebaseUser!.email || null,
    },
    profile: snapshot.exists ? snapshot.data() : null,
  });
});

export default router;
