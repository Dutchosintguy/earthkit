"use client";

import useClerkSWR from "@/lib/api";
import { Skeleton } from "./ui/skeleton";
import { Progress } from "./ui/progress";
import { UsageData } from "@/lib/db";
import { useAuth } from "@clerk/nextjs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function UsageBar() {
  let { isSignedIn } = useAuth();
  let { data, isLoading } = useClerkSWR("/api/usage");
  if (!isSignedIn) return null;
  data = data as UsageData;
  if (isLoading) return <Skeleton className="h-5 w-full px-6" />;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <div className="flex flex-col gap-1 mx-6 bg-muted/60 rounded-md p-3">
            <div className="text-sm w-full text-left">
              {data.remaining} Usage Units Left
            </div>
            <Progress
              className="h-[10px]"
              value={(data.remaining / data.quota) * 100}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-sm prose prose-sm">
            {data.remaining} / {data.quota} Usage Units Left. <br />
            Please reach out on{" "}
            <a href="https://discord.gg/ZTBM8AbK">discord</a> <br /> or email at
            contact@earthkit.app <br /> if you need more.
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
