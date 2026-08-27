ALTER TABLE `evaluationDimensions` ADD `dimensionType` varchar(32) DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `evaluationDimensions` ADD `referenceAudioFileId` int;--> statement-breakpoint
ALTER TABLE `evaluationDimensions` ADD `targetGroupLabels` text;