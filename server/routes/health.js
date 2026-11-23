/**
 * 역할: GET /api/health 요청에 서버의 실행 상태와 서비스 이름을 반환하는 상태 확인 라우터다.
 */

import { Router } from 'express';

const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  response.status(200).json({
    status: 'ok',
    service: 'levit-problem-solver'
  });
});

export default healthRouter;
