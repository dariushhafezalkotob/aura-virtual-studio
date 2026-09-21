import { addCrewSeat, canOpenProject, isProjectOwner, listCrew, removeCrewSeat } from '../lib/crew';

/**
 * Crew seats for one project: /api/projects/:id/crew
 *
 * Anyone on the project can see who else is on it. Only the owner can add or remove people,
 * because a seat carries a password and access to the work.
 */

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk;
      if (body.length > 20_000) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: any, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** Handles /api/projects/<id>/crew[/<userId>]. Returns true when it answered. */
export async function handleCrewApi(req: any, res: any): Promise<boolean> {
  const path = (req.url || '').split('?')[0];
  const match = /^\/api\/projects\/([^/]+)\/crew(?:\/([^/]+))?$/.exec(path);
  if (!match) return false;

  const projectId = decodeURIComponent(match[1]);
  const memberId = match[2] ? decodeURIComponent(match[2]) : null;
  const user = req.auraUser;

  try {
    if (!(await canOpenProject(user._id, projectId))) {
      sendJson(res, 404, { success: false, error: 'No such project.' });
      return true;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, { success: true, crew: await listCrew(projectId) });
      return true;
    }

    // Adding or removing a seat is the owner's call alone.
    if (!(await isProjectOwner(user._id, projectId))) {
      sendJson(res, 403, { success: false, error: 'Only the project owner can change the crew.' });
      return true;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const member = await addCrewSeat(projectId, body);
      sendJson(res, 200, { success: true, member });
      return true;
    }

    if (req.method === 'DELETE' && memberId) {
      await removeCrewSeat(projectId, memberId);
      sendJson(res, 200, { success: true });
      return true;
    }

    sendJson(res, 405, { success: false, error: 'Unsupported method.' });
    return true;
  } catch (err: any) {
    console.error('[API crew]', err?.message || err);
    sendJson(res, 400, { success: false, error: err?.message || 'Could not update the crew.' });
    return true;
  }
}
