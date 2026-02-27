<?php

namespace Vadkuz\RussianLangpack\Api\Controller;

use Flarum\Http\RequestUtil;
use Laminas\Diactoros\Response\JsonResponse;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Vadkuz\RussianLangpack\Sync\TranslationSyncManager;

class SyncTickController implements RequestHandlerInterface
{
    public function __construct(private readonly TranslationSyncManager $syncManager)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $actor = RequestUtil::getActor($request);
        $actor->assertAdmin();

        return new JsonResponse($this->syncManager->tick());
    }
}
