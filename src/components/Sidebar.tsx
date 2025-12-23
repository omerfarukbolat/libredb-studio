"use client";

import React from 'react';
import { DatabaseConnection, TableSchema } from '@/lib/types';
import { Plus, Database, HardDrive, Cpu, Cloud, Trash2, Zap, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { SchemaExplorer } from './SchemaExplorer';

interface ConnectionsListProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onAddConnection: () => void;
}

export function ConnectionsList({ 
  connections, 
  activeConnection, 
  onSelectConnection, 
  onDeleteConnection, 
  onAddConnection 
}: ConnectionsListProps) {
  return (
    <section>
      <div className="px-3 mb-2 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-600">
          Connections
        </span>
        <div className="h-[1px] flex-1 bg-white/5 ml-3" />
      </div>
      
      <div className="space-y-0.5">
        {connections.length === 0 ? (
          <div className="px-3 py-6 text-center border border-dashed border-white/5 rounded-lg mx-2">
            <p className="text-[11px] text-zinc-600 mb-3 leading-relaxed">No database connections established yet.</p>
            <Button 
              variant="outline" 
              size="sm" 
              className="h-7 text-[10px] border-white/10 hover:bg-white/5"
              onClick={onAddConnection}
            >
              Add Connection
            </Button>
          </div>
        ) : (
          connections.map((conn) => (
            <motion.div 
              key={conn.id}
              initial={false}
              className={cn(
                "group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 text-sm relative overflow-hidden",
                activeConnection?.id === conn.id 
                  ? "bg-blue-600/10 text-blue-400" 
                  : "hover:bg-white/[0.03] text-zinc-500 hover:text-zinc-200"
              )}
              onClick={() => onSelectConnection(conn)}
            >
              {activeConnection?.id === conn.id && (
                <motion.div 
                  layoutId="active-indicator"
                  className="absolute left-0 w-1 h-4 bg-blue-500 rounded-r-full" 
                />
              )}
              <div className={cn(
                "p-1 rounded transition-colors",
                activeConnection?.id === conn.id ? "bg-blue-500/20" : "bg-zinc-900 group-hover:bg-zinc-800"
              )}>
                {conn.type === 'postgres' && <Cloud className="w-3 h-3" />}
                {conn.type === 'mysql' && <HardDrive className="w-3 h-3" />}
                {conn.type === 'mongodb' && <Layers className="w-3 h-3" />}
                {conn.type === 'redis' && <Cpu className="w-3 h-3" />}
                {conn.type === 'sqlite' && <Database className="w-3 h-3" />}
                {conn.type === 'demo' && <Zap className="w-3 h-3 text-yellow-500" />}
              </div>
              <span className="truncate flex-1 font-medium text-[13px]">{conn.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteConnection(conn.id);
                }}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </motion.div>
          ))
        )}
      </div>
    </section>
  );
}

interface SidebarProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  schema: TableSchema[];
  isLoadingSchema: boolean;
  onSelectConnection: (connection: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onAddConnection: () => void;
  onTableClick?: (tableName: string) => void;
  onGenerateSelect?: (tableName: string) => void;
  onCreateTableClick?: () => void;
  onShowDiagram?: () => void;
  isAdmin?: boolean;
  onOpenMaintenance?: (tab?: 'global' | 'tables' | 'sessions', table?: string) => void;
}

export function Sidebar({ 
  connections, 
  activeConnection, 
  schema, 
  isLoadingSchema,
  onSelectConnection, 
  onDeleteConnection,
  onAddConnection,
  onTableClick,
  onGenerateSelect,
  onCreateTableClick,
  onShowDiagram,
  isAdmin = false,
  onOpenMaintenance
}: SidebarProps) {
  return (
    <div className="hidden md:flex w-64 border-r border-white/5 flex-col bg-[#080808] select-none">
      <div className="h-14 px-4 flex items-center justify-between border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center">
            <Zap className="w-3.5 h-3.5 text-white fill-current" />
          </div>
            <span className="font-bold text-sm tracking-tight bg-gradient-to-r from-white to-zinc-500 bg-clip-text text-transparent">
              LibreDB Studio
            </span>
        </div>
        <div className="flex items-center gap-1">
          {activeConnection && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-8 w-8 hover:bg-white/5 text-zinc-500 hover:text-white transition-colors"
              onClick={onShowDiagram}
              title="Show ERD Diagram"
            >
              <Layers className="w-4 h-4" />
            </Button>
          )}
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-8 w-8 hover:bg-white/5 text-zinc-500 hover:text-white transition-colors"
            onClick={onAddConnection}
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-2 py-4">
        <div className="space-y-6">
          <ConnectionsList 
            connections={connections}
            activeConnection={activeConnection}
            onSelectConnection={onSelectConnection}
            onDeleteConnection={onDeleteConnection}
            onAddConnection={onAddConnection}
          />

            {activeConnection && (
              <SchemaExplorer 
                schema={schema}
                isLoadingSchema={isLoadingSchema}
                onTableClick={onTableClick}
                onGenerateSelect={onGenerateSelect}
                onCreateTableClick={onCreateTableClick}
                isAdmin={isAdmin}
                onOpenMaintenance={onOpenMaintenance}
              />
            )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-white/5 bg-[#0a0a0a]/50 backdrop-blur-md">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-white/[0.02] border border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] font-medium text-zinc-500">Connected</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-700">v1.2.5</span>
        </div>
      </div>
    </div>
  );
}
